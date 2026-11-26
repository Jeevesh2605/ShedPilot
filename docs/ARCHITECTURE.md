# ShedPilot architecture

ShedPilot is an AI SRE agent that sheds load by turning off feature flags. When the demo backend comes under stress, the agent measures which flagged feature uses the most compute. It proposes turning off the smallest set of non-essential flags, waits for a human to approve in Slack, flips the flags in Flagsmith, and later proposes turning them back on.

One rule shapes the whole design: **the LLM proposes, code decides.** The model only writes a proposal as JSON. Deterministic code checks it against Flagsmith's live state and tags, a human approves it, and only then does code change a flag.

This document started as Phase 0. Section 9 lists the open questions, and section 10 records decisions made while building.

---

## 1. System diagram

```mermaid
flowchart LR
    LT[Load test<br/>open-loop generator] -->|HTTPS| APIGW[API Gateway<br/>HTTP API]
    APIGW --> RA[reports-api Lambda<br/>reserved concurrency 5]
    RA -->|server-side SDK<br/>5 s in-memory cache| FSF[(Flagsmith<br/>Flags API)]
    RA -->|1 JSON log line per request| CWL[(CloudWatch Logs)]
    RA -.->|Throttles, Duration| CWM[(CloudWatch Metrics)]
    APIGW -.->|Latency p90, 5xx| CWM

    CWM --> AL1[Alarm: Throttles > 0]
    CWM --> AL2[Alarm: API p90 latency]
    AL1 --> SNS[SNS topic]
    AL2 --> SNS
    SNS --> INV[investigator Lambda]

    INV -->|GetMetricData| CWM
    INV -->|Logs Insights query| CWL
    INV -->|list features, states, tags| FSA[(Flagsmith<br/>Admin API)]
    INV -->|evidence in, JSON proposal out| LLM[Claude via<br/>Amazon Bedrock]
    INV -->|guardrail check, then save| DDB[(DynamoDB<br/>incidents)]
    INV -->|Block Kit + buttons| SLACK[Slack channel]

    SLACK -->|button click| CB[slack-callback Lambda<br/>Function URL]
    CB -->|verify signature<br/>conditional write| DDB
    CB -->|async invoke| EX[executor Lambda]
    EX -->|re-check, then flip flags| FSA
    EX --> DDB
    EX -->|chat.update| SLACK

    EB[EventBridge schedule] --> REC[recovery Lambda]
    REC -->|GetMetricData + Logs Insights| CWM
    REC --> DDB
    REC -->|re-enable proposal,<br/>final report| SLACK
```

The LLM has no Flagsmith credentials and no tools. It receives evidence as text and returns JSON. Only the executor holds a Flagsmith Admin API key with write access, and it acts only on an approval already recorded in DynamoDB.

---

## 2. What the Flagsmith docs say

You asked me not to guess endpoints, so I read the docs and the official OpenAPI spec. The spec is at `https://api.flagsmith.com/api/v1/swagger.json`, and every path below comes from it.

### 2.1 Two APIs, two kinds of key

| API | Used by | Base URL | Auth header | Key type |
|---|---|---|---|---|
| Flags API (SDK) | reports-api | `https://edge.api.flagsmith.com/api/v1/` (the Node SDK default) | sent by the SDK as `X-Environment-Key` | Server-side environment key, prefixed `ser.` |
| Admin API (Management API) | seed script, investigator, executor | `https://api.flagsmith.com/api/v1/` | `Authorization: Api-Key <key>` | Organisation API key, from Organisation → API Access → Create API Key |

The docs quote the header exactly as `Authorization: Api-Key <API TOKEN FROM ORGANISATION PAGE>`. The spec also lists a `Token <token>` scheme, which is for personal user tokens. ShedPilot uses only the organisation `Api-Key` form. When you create that key, Flagsmith lets you choose full admin rights or a set of RBAC roles. Section 9 asks whether you want to scope it down.

### 2.2 Server-side Node SDK

- The package is `@flagsmith/nodejs` (version 9 and later, Node 18 or newer). The older `flagsmith-nodejs` package is deprecated.
- You call `new Flagsmith({ environmentKey, requestTimeoutSeconds, defaultFlagHandler, ... })`, then `await flagsmith.getEnvironmentFlags()`, then `flags.isFeatureEnabled('pdf_export')`.
- In the default **remote evaluation** mode, every `getEnvironmentFlags()` call makes a blocking network request.
- In **local evaluation** mode, the SDK downloads the environment document and polls it, every 60 seconds by default.
- The SDK has no built-in in-memory cache for Node. It accepts a pluggable `cache: { get, set }` object.
- `defaultFlagHandler` decides what a flag returns when Flagsmith can't be reached.
- The docs say nothing about Lambda.

**Decision.** Use remote evaluation, plus our own small in-memory cache with a 5-second time-to-live in the Lambda module scope.

- It meets your "at most 5 seconds" rule exactly.
- It's easy to explain to judges.
- It avoids a background polling timer, which Lambda freezes between invocations.

The cost is at most one Flags API call per warm container every 5 seconds. With 5 containers that is about 60 calls a minute during a test.

**Fail-safe default.** If Flagsmith can't be reached, `defaultFlagHandler` returns `enabled: false` for heavy optional features and `true` for `checkout_core`, so an outage at Flagsmith can't add load to us. Section 9 asks you to confirm this.

### 2.3 Admin API calls ShedPilot makes

| Purpose | Method and path | Notes from the spec |
|---|---|---|
| Find project ID | `GET /api/v1/projects/` | |
| Find environment ID and key | `GET /api/v1/environments/?project=<id>` | Returns numeric `id`, string `api_key`, and `use_v2_feature_versioning` |
| List tags | `GET /api/v1/projects/{project_pk}/tags/` | Tag object: `id`, `label`, `color`, `description` |
| Create tag (seed) | `POST /api/v1/projects/{project_pk}/tags/` | Body `{"label": "load-sheddable", "color": "#...", "description": "..."}`. Only `label` is required. |
| List features **with live state** | `GET /api/v1/projects/{project_pk}/features/?environment=<env id>&page_size=100` | The `environment` parameter takes the numeric ID. Each feature then includes `environment_feature_state.enabled`. `tags` is an **array of tag IDs, not labels**, so we map IDs to labels with the tags call. The docs say this works for v1 and v2 versioned environments. |
| Create feature (seed) | `POST /api/v1/projects/{project_pk}/features/` | Body `{"name": "pdf_export", "default_enabled": true, "description": "...", "tags": [<tag id>]}`. Only `name` is required. |
| **Turn a flag on or off** | `PATCH /api/__future__/environments/{environment_key}/features/{feature_id}/` | Body `{"environment_default": {"enabled": false}}`. PATCH leaves omitted fields unchanged. Returns 200 with the flag's full state. |
| Read a flag's state | `GET /api/__future__/environments/{environment_key}/features/{feature_id}/` | Used to re-check before the write and to verify after it |
| Legacy toggle (fallback only) | `PATCH /api/v1/environments/{environment_api_key}/featurestates/{id}/` | Body `{"enabled": false}`. **Returns 400 on environments with Feature Versioning v2.** |

**Why the `__future__` endpoint, and its risks.**

- The legacy feature-state write fails on v2-versioned environments.
- Turning v2 versioning on is irreversible, per the feature-versioning docs.
- The `__future__` update endpoint is the one documented single call that turns a flag off.

The docs label it **"experimental and may change without notice"**, and they also say it can't update flags **when change requests are enabled**. So the executor will check the environment's `use_v2_feature_versioning` and pick the endpoint behind one small function, so a change to either path touches one file.

Two items are still unverified:

- The docs don't say whether `{environment_key}` means the string `api_key` or the numeric ID. The spec types it as a string, which suggests `api_key`.
- I haven't confirmed that the `__future__` path behaves as described on a live account.

In Phase 1 I'll give you a read-only `GET` to run against your environment to settle both.

**Pagination and limits.** Responses use the standard `count`, `next`, `previous`, `results` shape. The Admin API has a rate limit, documented on Flagsmith's system limits page. ShedPilot makes about 5 Admin API calls per incident, which is well below it.

### 2.4 MCP server and CLI, the Track 2 extras

- **MCP server.** Flagsmith hosts it at `https://mcp.flagsmith.com`. It authenticates with OAuth or with `Authorization: Api-Key <org key>`. Its tools include `list_project_features`, `get_feature_flag`, `update_feature_state` (v1 environments), and `update_environment_feature_version_state` (v2 environments). It lists no tag tools.
- **CLI.** The new `flagsmith` CLI installs with Homebrew or npm. It supports `flagsmith init`, toggling flags, `flagsmith eval <feature>`, and raw `flagsmith api /projects/` calls. I read only its overview page, not the full command reference, so I'll check the README before using any command.

**Decision.** The runtime path uses the Admin API directly. It's deterministic, testable, and easy to put least-privilege limits on. The MCP server and CLI show up in the demo as independent views of Flagsmith. For example, ask Claude through the Flagsmith MCP server "what's the state of pdf_export?" after approval, or run `flagsmith eval pdf_export` in a terminal shot. That proves the flip happened in Flagsmith itself. The MCP "investigation tool" stays a stretch goal, as you specified.

---

## 3. Components

### 3.1 reports-api, the demo backend

API Gateway HTTP API in front of one Node.js 20 Lambda with **reserved concurrency 5**.

| Route | Flag | Sheddable | Work done |
|---|---|---|---|
| `GET /api/reports?format=pdf` | `pdf_export` | yes | Builds a real multi-page PDF with `pdfkit`, taking 2 to 4 s of CPU. With the flag off, it returns 200 with JSON saying PDF export is temporarily unavailable, plus a CSV link. |
| `GET /api/reports?format=csv` | `basic_csv` | yes | Small CSV, fast |
| `GET /api/reports/summary` | `rich_analytics` | yes | Summary JSON. With the flag on, it adds about 1 s of real CPU-bound aggregation. |
| `GET /api/checkout` | `checkout_core` | **no** | Fast core endpoint. It exists to prove the guardrail. |

- **No fake load.** There is no `sleep` or `setTimeout`. PDF size comes from an environment variable for page count, and aggregation size from a row-count variable. Phase 1 tunes both so the timings land in range at the chosen Lambda memory size. Memory sets CPU share in Lambda, so the two are tuned together.
- **Log line.** Every request writes one JSON line, so Logs Insights can find it by field:

```json
{"type":"request","request_id":"...","route":"/api/reports","format":"pdf",
 "features_evaluated":{"pdf_export":true},
 "feature_timings_ms":{"pdf_export":2870},
 "duration_ms":2912,"status":200}
```

- **Blind spot.** A throttled request never reaches the Lambda, so it leaves no app log. The evidence therefore combines two sources. CloudWatch metrics say how much was rejected. The logs say what the served requests spent compute on. The LLM prompt states this blind spot openly.

### 3.2 Detection

- **Alarm A, the primary signal.** Metric `AWS/Lambda Throttles`, dimension `FunctionName=reports-api`, statistic `Sum`, threshold `> 0`. It uses a 60 s period, 1 evaluation period, and treats missing data as not breaching.
- **Alarm B.** Metric `AWS/ApiGateway Latency`, dimension `ApiId`, extended statistic `p90`, threshold `> 2500 ms` as a parameter. It uses a 60 s period and 1 evaluation period.
- Both alarms publish their ALARM transition to one SNS topic, which triggers the investigator.
- **Two alarms can fire at the same moment, so de-duplication must be atomic.** Section 4.2 explains how.

### 3.3 investigator Lambda (SNS trigger, 120 s timeout)

1. **Claim the incident lock** with a conditional put, described in section 4.2. If another incident is open, it logs the duplicate and exits. It sends no Slack message.
2. **Gather evidence** for the last 5 minutes:
   - It calls `GetMetricData` for reports-api `Invocations`, `Throttles`, `Errors`, `ConcurrentExecutions` max, and `Duration` p50/p90, plus API `Latency` p50/p90 and `5xx`, all at 1-minute resolution.
   - It runs a Logs Insights query. In outline it is `filter type="request" | stats count(*), avg(feature_timings_ms.pdf_export), pct(feature_timings_ms.pdf_export, 90), sum(...)` for each flag. Code then computes each feature's share of total compute time.
   - Logs Insights is asynchronous: start the query, then poll for results, with a 30 s cap.
3. **Read Flagsmith** with the features-with-state call and the tags call. It builds a list of `{name, id, enabled, tags: [labels]}` and leaves out archived features.
4. **Ask the LLM** for strict JSON with `diagnosis`, `actions[]`, `alternatives_considered`, and `confidence`. Each action is `{flag, action, reason, evidence, expected_effect, user_impact}`. The prompt asks for the minimum set of flags that addresses the measured cause, and for the lowest user impact.
5. **Run the guardrail**, which is pure code and fully unit-tested. For each action:
   - the flag must exist
   - it must be enabled right now
   - it must carry the `load-sheddable` tag
   - the action must be `"disable"`
   - it must not be a duplicate of an earlier action in the same proposal

   It also caps a proposal at 3 flags, a parameter. Actions that fail are kept in the record with the reason they were blocked, such as `"checkout_core: missing tag load-sheddable"`.
6. **Save** the incident to DynamoDB with the evidence, the raw LLM output, the parsed proposal, and the guardrail results.
   - If any action passed, the status is `PENDING_APPROVAL`.
   - If none passed, the status is `NO_SAFE_ACTION`.
7. **Post to Slack:**
   - what is wrong
   - the evidence as numbers
   - each approved-to-propose action, with its expected effect and user impact
   - any guardrail rejections, shown openly
   - Approve and Reject buttons

   A `NO_SAFE_ACTION` message has no buttons and releases the lock.

**If the LLM fails** (malformed JSON after one retry, refusal, timeout, or Bedrock error), the investigator still posts the evidence with "investigation failed: \<reason\>, no action proposed". It never falls back to "disable everything sheddable".

### 3.4 slack-callback Lambda (Function URL, public)

1. Read the raw body. Verify `X-Slack-Signature`, computed as `v0=HMAC_SHA256(signing_secret, "v0:" + X-Slack-Request-Timestamp + ":" + body)`, using a constant-time compare. Reject timestamps older than 5 minutes. Any failure returns 401.
2. Parse the `payload`. Each button's `value` carries `{incidentId, decision, phase}`. `phase` is `shed` or `restore`.
3. Make **one conditional DynamoDB write**, for example `PENDING_APPROVAL → APPROVED` with `approvedBy`, `approvedAt`, and the Slack user. This write is the recorded human approval. A double click, a retry, or a second approver fails the condition and gets an ephemeral "already handled by @x" reply.
4. Async-invoke the executor (`InvocationType: Event`) and return 200 to Slack, all within 3 s. **This path never calls Flagsmith.**

### 3.5 executor Lambda (async invoke only, 60 s timeout)

1. Load the incident. Continue only if its status is `APPROVED` or `RESTORE_APPROVED`, which means an approval is already recorded.
2. **Re-check right before writing.** Read each flag's live state. Re-run the guardrail, because someone may have changed a flag or tag since the proposal.
3. Without `DRY_RUN`, PATCH each flag through the `__future__` endpoint, then GET to verify it. With `DRY_RUN=true`, log the exact request it would send and change nothing.
4. Record the result for each flag. Set the status to `SHED` or `RESOLVED`. If some flags succeeded and others failed, set `PARTIAL` and list them.
5. Update the original Slack message with `chat.update`: which flags changed, who approved, and when.
6. On rejection, it changes nothing in Flagsmith. It sets `REJECTED`, releases the lock, and updates the message.

### 3.6 recovery Lambda (EventBridge, 1 minute for the demo, 10 minutes by default)

For the open incident in `SHED`:

1. **Is it healthy?** Throttles must be zero and API p90 must be below the healthy threshold for N consecutive minutes, where N is a parameter.
2. **Is it safe to restore?** Being healthy only proves the shedding worked. While the spike lasts, the PDF route still gets traffic, and it is fast only because the flag is off. So recovery also counts recent requests to each shed route, which keep logging `features_evaluated.pdf_export=false`. It estimates the load a restore would add as requests per second × the feature's average time from the original evidence. That estimate must fit within 60% of the reserved concurrency (a parameter). Section 9 asks you to confirm this rule.
3. When both checks pass, it posts a re-enable proposal with before and after numbers and Approve or Keep disabled buttons. Approval runs through the same callback and executor path, with the status moving to `RESTORE_APPROVED`, then `RESOLVED`.
4. "Keep disabled" returns the incident to `SHED` with a cooldown, 10 minutes by default, before the next proposal.
5. On `RESOLVED`, it posts the incident report: timeline, evidence, actions, approvers, and total time degraded. It then releases the lock.

---

## 4. State

### 4.1 Incident state machine

```mermaid
stateDiagram-v2
    [*] --> INVESTIGATING: alarm, lock acquired
    INVESTIGATING --> PENDING_APPROVAL: at least one action passed the guardrail
    INVESTIGATING --> NO_SAFE_ACTION: nothing passed, or the LLM failed
    PENDING_APPROVAL --> APPROVED: human clicks Approve (conditional write)
    PENDING_APPROVAL --> REJECTED: human clicks Reject
    PENDING_APPROVAL --> EXPIRED: no response in 30 min
    APPROVED --> SHED: executor turned the flags off
    APPROVED --> FAILED: Flagsmith error or re-check failed
    SHED --> RESTORE_PROPOSED: healthy for N min and safe to restore
    RESTORE_PROPOSED --> RESTORE_APPROVED: human clicks Approve
    RESTORE_PROPOSED --> SHED: human clicks Keep disabled (cooldown)
    RESTORE_APPROVED --> RESOLVED: executor turned the flags back on
    RESTORE_APPROVED --> FAILED
    RESOLVED --> [*]: report posted, lock released
    REJECTED --> [*]: lock released
    NO_SAFE_ACTION --> [*]: lock released
    EXPIRED --> [*]: lock released
    FAILED --> [*]: error posted to Slack, lock kept for a human
```

- All allowed transitions live in one table in code, for example `canTransition(from, to)`.
- Every DynamoDB status change is a conditional update on the expected current status. That's what makes double clicks and retries safe.
- `FAILED` keeps the lock on purpose. If a flag might be half-changed, a human should look before the agent acts again. Section 9 asks you to confirm.

### 4.2 DynamoDB, one on-demand table

| pk | sk | Contents |
|---|---|---|
| `LOCK#reports-api` | `LOCK` | `incidentId` of the open incident. It's created with `attribute_not_exists(pk)` and deleted when the incident ends. **This is the de-duplication**, and it is atomic even when both alarms fire together. |
| `INCIDENT#<id>` | `META` | Status, timestamps, evidence, proposal, guardrail results, approvals, Slack channel and message timestamp |
| `INCIDENT#<id>` | `EVENT#<iso-ts>#<n>` | Append-only audit trail, for example "alarm received", "LLM proposed", "guardrail rejected checkout_core", "approved by U123", "flag pdf_export disabled" |

Recovery reads the lock item to find the open incident, so the table needs no secondary index or scan.

---

## 5. Approval flow

```mermaid
sequenceDiagram
    participant S as Slack
    participant CB as slack-callback
    participant D as DynamoDB
    participant EX as executor
    participant F as Flagsmith Admin API
    S->>CB: button click (signed)
    CB->>CB: verify signature + timestamp
    CB->>D: UPDATE status=APPROVED IF status=PENDING_APPROVAL
    alt condition fails (double click / retry)
        CB-->>S: 200 + ephemeral "already handled"
    else ok
        CB->>EX: async invoke
        CB-->>S: 200 (under 3 s)
        EX->>F: GET flag state (re-check)
        EX->>F: PATCH environment_default.enabled=false
        EX->>F: GET (verify)
        EX->>D: status=SHED, audit events
        EX->>S: chat.update with result
    end
```

---

## 6. LLM

- **Provider.** Groq, by default, running OpenAI's open-weight `openai/gpt-oss-120b`, through Groq's OpenAI-compatible Chat Completions API. Groq is groq.com, with keys starting `gsk_`. It is a different company from xAI's Grok.
- **Why not Claude.** The brief planned Claude on Amazon Bedrock. Bedrock access stayed denied for over a month, there's no Anthropic API key, and a Groq free-tier key is available.
- **Providers in code.** `LlmProvider` in `agent/lib/llm.ts` has two implementations: `groq` (the default) and `xai` (for a real Grok key with the `xai-` prefix). Claude can be added as a third.
- **Strict output.** `response_format` is a `json_schema` with `strict: true`. On Groq this is constrained decoding, so the output always matches the schema. Code still parses and validates every field in `proposalParser.ts`.
- **What the prompt holds.** Metrics, flag names and descriptions, about 1,000 tokens, and no secrets. The JSON is sent compact, because the free tier allows 8,000 tokens a minute.
- **Free-tier limits for gpt-oss-120b on Groq.** 30 requests a minute, 1,000 a day and 8,000 tokens a minute. One incident uses one or two requests.
- **One retry.** A malformed answer gets one retry that says what was wrong.
- **Fallback.** On an API failure, such as a rate limit, or after two malformed answers, the investigator uses the rule-based proposal and labels it in Slack.
- **The guardrail runs on every proposal,** whoever made it, and again in the executor before any write.

---

## 7. Security and safety

| Rule | How it's enforced |
|---|---|
| No flag changes without a recorded human approval | The executor runs only from an `APPROVED` or `RESTORE_APPROVED` status. Only slack-callback writes that status, after checking the Slack signature. |
| The LLM never calls Flagsmith | The LLM has no tools. The investigator's role has no Flagsmith write path. Only the executor's role can read the write-capable key. |
| Only sheddable flags are changed | The guardrail runs at proposal time **and again** in the executor just before the write. |
| Secrets | SSM Parameter Store `SecureString` under `/shedpilot/*`. Each function can read only the parameters it needs. A `.env.example` lists the names only. |
| Least-privilege IAM | Each function gets its own role. Only slack-callback may invoke the executor. Only the investigator and recovery functions may run Logs Insights queries, and only on the reports-api log group. |
| Safe rehearsal | `DRY_RUN=true` makes the executor log the request without sending it. |

---

## 8. Repo layout, cost and teardown

```
backend/          reports-api handler and flag client
agent/
  investigator/  slack-callback/  executor/  recovery/
  lib/           flagsmith.ts cloudwatch.ts llm.ts slack.ts guardrails.ts incidents.ts
loadtest/         baseline and spike profiles (open-loop, random arrivals)
scripts/          seed-flags.ts, teardown.sh
docs/             ARCHITECTURE.md, DEMO_SCRIPT.md
template.yaml     single SAM template, esbuild bundling
```

**Load test rate cap.** Throttled requests come back almost instantly. An uncapped tool with 20 connections would therefore send thousands of requests a minute. The load test is open-loop: requests arrive at random times at a fixed average rate. The spike averages 8 requests per second for 180 s, about 1,440 requests in total.

**Expected cost.** Almost everything falls within the AWS free tier or costs a few rupees:

- Lambda, API Gateway, DynamoDB on demand, SNS, and a few MB of logs.
- Two standard alarms at about US$0.10 per alarm per month.
- `GetMetricData` and Logs Insights, at fractions of a cent per run.

There are two exceptions, and I'll warn you before each:

1. **Bedrock calls**, starting in Phase 4. A few US cents per incident, and the demo uses fewer than 20.
2. **Leaving the stack running.** A 1-minute recovery schedule runs all month and stays within the free tier, but alarms and logs keep billing. `scripts/teardown.sh` runs `sam delete` and removes the `/shedpilot/*` SSM parameters. A Flagsmith cleanup step that deletes the seeded flags is optional.

---

## 9. Open questions for you

1. **Lambda concurrency limit.** AWS refuses reserved concurrency that would leave fewer than 100 unreserved executions in an account. Many new accounts have a limit of only 10, so `ReservedConcurrentExecutions: 5` would fail to deploy. Please run `aws lambda get-account-settings` and tell me `ConcurrentExecutions`. If it's 10, the options are to request a quota increase (free, takes hours to days) or redesign the throttle signal.
2. **AWS region and Bedrock access.** Which region should the stack use? Is Claude Opus 5.5 enabled for your account in Bedrock there? If not, should we start with the Anthropic API?
3. **Flagsmith setup.** Do you have a SaaS project and environment ready? Is Feature Versioning v2 on, and are change requests enabled? The `__future__` update endpoint doesn't work with change requests.
4. **Admin API key scope.** Should the key have full organisation admin rights, which is simpler, or an RBAC role limited to this project, which is safer to describe to judges? Role-based keys may depend on your Flagsmith plan.
5. **Who can approve.** Should anyone in the Slack channel be able to approve, or only an allowlist of Slack user IDs set as a parameter? I recommend the allowlist. It's one line of config and not an auth system.
6. **Recovery rule.** Do you agree that "healthy" should also require that the demand on the shed route fits the spare capacity (section 3.6)? Without that, ShedPilot will propose a restore in the middle of the spike, and approving it would break things again.
7. **Fail-safe defaults when Flagsmith is down.** Optional heavy features off and `checkout_core` on. Agreed?
8. **Thresholds.** Latency alarm p90 above 2,500 ms, healthy below 800 ms for N=3 consecutive minutes, and approval expiry after 30 minutes. Do you want different numbers?
9. **Lock after a failure.** Should a `FAILED` incident keep the lock until a human clears it, as I propose, or release it automatically?
10. **Git and commits.** You told me not to create a repository or make commits, but the submission brief asks for a clean commit history for each phase. I'll leave all git work to you. Each phase summary will include a suggested commit message.

---

## 10. Decisions made while building

| Phase | Decision | Why |
|---|---|---|
| 1 | Lambda runtime `nodejs22.x` instead of Node.js 20 | AWS deprecated `nodejs20.x` on 2026-04-30, and new functions on it may already be blocked. The code is the same. |
| 1 | `ReservedConcurrency` is a template parameter, set to 0 for now | The account's concurrency quota is 10, so AWS refuses any reservation. A quota increase has to be requested (docs/SETUP.md, step 1). Phases 2 and 3 need it. |
| 1 | reports-api runs at 512 MB, with 110 PDF pages | Locally a PDF page costs about 2.6 ms. On Lambda at 512 MB, 150 pages took about 4 s warm, so 110 pages targets about 3 s. Analytics at 400,000 rows took 0.7 to 1.1 s. |
| 1 | pdfkit is imported from its standalone build | The normal build reads font files from disk, which breaks after esbuild bundling. The standalone build embeds them. |
| 1 | The update endpoint's `{environment_key}` is the environment's string `api_key` | Settled by the seed script's read-only GET. The string key returned 200, and the numeric ID returned 404. |
| 1 | The executor must use the `__future__` update endpoint | The Development environment (id 116113) has Feature Versioning v2 on, so legacy feature-state writes would fail. Change requests are off, so the endpoint can make changes. |
| 1 | Scripts read the AWS region from `samconfig.toml` | The shell had `AWS_REGION=us-east-1` while the stack deploys to ap-south-1. The secrets went to the wrong region and every request failed with `ParameterNotFound`. |
| 1 | Flagsmith SDK timeout 2 s, 1 retry | The SDK defaults (10 s timeout, 3 retries) would make every request slow during a Flagsmith outage. Failing fast to the safe defaults is better. |
| 1 | The load test is a small open-loop generator, not autocannon | autocannon caused two false results. With an overall rate cap, it silently cut 20 connections down to 8, so the first spike never throttled. With a per-connection cap, it fired all 20 connections on the same tick, so even fast degraded requests arrived in bursts of 20 and were throttled at the limit of 10. With random arrivals at a fixed average rate, overload comes only from real work. |
| 2 | Two stacks instead of one `template.yaml`: `shedpilot` (app, alarms, SNS) and `shedpilot-agent` (table, agent Lambdas) | The Lambda concurrency limit applies per region. With the agent in its own stack, one setting in `agent/samconfig.toml` can move it to a second region with its own concurrency pool, if the quota increase is not granted. The alarms stay next to the metrics they watch. An SNS subscription works across regions. |
| 2 | Latency is reported as the worst single minute's p90 | Percentiles can't be combined across minutes, and a long CloudWatch period over an unaligned window can split into two buckets. "Worst minute" is exact and easy to explain. |
| 2 | A rule-based stand-in proposes the action until Phase 4 | It returns the same `Proposal` shape the LLM will return, so incidents, Slack and the executor don't change when Claude arrives. It picks the top compute feature only if it uses at least 30% of compute, is on, and is tagged `load-sheddable`. |
| 2 | The Slack message is posted before the status is saved as `PENDING_APPROVAL` | If the save fails after posting, the buttons point at an incident that is not pending, and the Phase 3 callback refuses them. The reverse order could leave an incident pending with no message anyone can act on. |
| 3 | The agent stack moved to Singapore (`ap-southeast-1`) | The account's concurrency limit is still 10 per region, and the Phase 2 run showed the investigator being throttled during the spike. A throttled Slack click would simply fail, so the agent gets its own region's pool of 10. It reads Mumbai's metrics, logs and secrets across regions. |
| 3 | slack-callback acts only on the incident that holds the lock, and only within 30 minutes | A button on an old message, or on an incident cleared with `reset-incident.sh`, could otherwise flip flags based on stale evidence. Such clicks expire the proposal instead. |
| 3 | The executor re-runs the guardrail against live Flagsmith state, reads every flag back after writing, and is never retried automatically | Something may have changed since the proposal. A read-back proves the change landed. A blind retry of a half-finished change could mislabel the incident. |
| 3 | The callback URL is a public Lambda Function URL with no AWS auth | Slack can't sign AWS requests. Every request is checked against Slack's signing secret and a 5-minute timestamp window. Unsigned and forged requests get 401. |
| 4 | Groq (`openai/gpt-oss-120b`) instead of Claude on Bedrock | Bedrock access was denied with no answer for over a month, and there's no Anthropic API key. The key available is a Groq free-tier key: it starts with `gsk_`, and xAI rejected it as "Incorrect API key". Groq supports strict schema output on this model. |
| 4 | An xAI Grok provider is kept as well | It was built first, because Groq and Grok were confused. It is a valid choice for anyone with an `xai-` key, and it shows the provider interface works. |
| 4 | On LLM failure, fall back to the rule-based proposal, labelled as such | A free-tier key may be rate-limited. The fallback is evidence-based, guardrailed and human-approved, so it's safe and more useful than "no action". |
| 4 | A labelled `rogue-demo` provider exists for the demo video | Groq never proposed `checkout_core`, even under prompt injection, so a well-behaved model never gives the guardrail anything to block. The rogue demo is a scripted model that proposes it on purpose. Its output says SIMULATED in the diagnosis, the model name and the Slack footer. It's selected only with `LlmProvider=rogue-demo`. |
| 4 | The investigator posts "Investigating…" at once, waits 60 s for CloudWatch, then replaces that message with the proposal | In the first Groq run, the throttle alarm fired 30 s into the spike, and the investigator read a minute CloudWatch had barely filled in. It saw latency p90 as 10 ms instead of 3,617 ms, and 20 invocations while the logs already showed 89. Groq faithfully repeated those numbers. The prompt now also says the latest minute may be incomplete. |
| 4 | A 5-minute `demo` load profile | With the settle wait, the proposal arrives about 1 min 45 s into a spike. A 3-minute run leaves too little time to show the approval and the recovery on camera. |
| 4 | Guardrail rejections are shown in Slack | The approver sees what the model proposed that code refused, for example `checkout_core: missing tag load-sheddable`. That is the safety model, made visible. |
| 5 | Recovery requires "healthy" AND "safe to restore" | Healthy alone would propose a restore in the middle of a spike, because the service is healthy *because* the flag is off. Safe means the demand still arriving on the degraded route, from the logs where a false flag reads as 0, times the feature's measured cost (Little's law), fits in 60% of the concurrency limit minus what's already in use. |
| 5 | The health window skips the 2 newest minutes | CloudWatch fills recent minutes in late, and an empty minute would look healthy. Demand comes from the logs, which are near real time. |
| 5 | The restore proposal is decided by code, not the LLM | It's arithmetic on measured numbers, so it's deterministic and testable. The Slack footer says so. |
| 5 | The schedule is a number of minutes, not a rate expression | EventBridge needs `rate(1 minute)` but `rate(10 minutes)`. The template builds the right form, and the deploy script never has to pass a value containing spaces. |
| 5 | The recovery Lambda also expires shedding proposals older than 30 minutes | An unanswered proposal would otherwise hold the lock forever and block new incidents. |
| 5 | Audit events for recovery checks are written only when the reason changes | A check every minute would otherwise flood the incident timeline and the report. |

### Phase 1 measurements (2026-11-12, ap-south-1, 512 MB, 110 pages)

| Measurement | Result |
|---|---|
| Warm PDF, `feature_timings_ms.pdf_export` | 3.5 to 3.8 s |
| Warm `rich_analytics` | 0.7 to 1.1 s |
| Baseline profile | 94 requests, 0 failures |
| Spike profile, `pdf_export` on (open-loop) | 1,417 requests, 779 got 503. PDF p90 latency was 4.0 s. 89 of 155 checkout requests failed as collateral damage. |
| Spike profile, `pdf_export` off (open-loop) | 1,365 requests, 0 failures. Every PDF request was degraded with p50 55 ms. Zero throttles, and peak concurrency 3 to 7. |
| API p90 latency during the spike | 3.5 to 3.6 s with the open-loop generator, and Lambda throttles of 150 to 280 a minute |
| Collateral damage | 149 of 206 checkout requests failed. The PDF work used up the concurrency that checkout needed. |

API p90 during the spike, about 3.5 s, is above the planned 2,500 ms alarm threshold. It is not far above, because the fast 503 responses pull the percentile down. The throttle alarm stays the primary signal.

### Phase 2 end-to-end run (2026-11-13, agent in ap-south-1)

| Time (UTC) | What happened |
|---|---|
| 13:25:40 | Spike started, `pdf_export` on |
| 13:26:27 | Latency alarm fired |
| 13:26:29 | Investigator claimed the lock and started incident `inc-20261113-132628-04ba` |
| 13:26:33 | Proposal ready: turn off `pdf_export`, which used 93% of served compute (131 requests, avg 3,021 ms, p90 4,225 ms). Posted to Slack, status `PENDING_APPROVAL`. |
| 13:26:42 | Throttle alarm fired. The investigator found the incident open and only added an audit event. |

The investigator itself was throttled once during the spike, because it shares the account limit of 10 with reports-api. AWS retried the asynchronous call, so nothing was lost. The Phase 3 Slack callback is a synchronous call and would fail outright, so Phase 3 needs either the quota increase or the agent in a second region.

### Phase 3 end-to-end run (2026-11-13, agent in ap-southeast-1)

| Time (UTC) | What happened |
|---|---|
| 14:40:27 | Latency alarm fired during the spike |
| 14:40:34 | Proposal posted: turn off `pdf_export` (94% of compute) |
| 14:40:42 | Throttle alarm fired; recorded on the open incident only |
| 14:42:34 | A human clicked Approve. slack-callback verified the request, recorded the approval and invoked the executor in 0.68 s. |
| 14:42:44 | The executor re-checked the guardrail, turned `pdf_export` off, read it back as off, set the status to SHED and updated the Slack message |

| Minute | reports-api throttles |
|---|---|
| 14:40 | 220 |
| 14:41 | 259 |
| 14:42 | 38 (approval at 14:42:34) |
| 14:43 onwards | 0 |

The executor took 9.4 s, almost all of it Flagsmith Admin API calls, which take 0.4 to 2.2 s each from outside. The callback now tells the approver straight away that the change is being applied. The investigator in Singapore was not throttled.

### Phase 4 model runs (2026-11-13, Groq `openai/gpt-oss-120b`, run locally with `npm run llm:try`)

| Scenario | Model proposed | Guardrail allowed | Latency | Notes |
|---|---|---|---|---|
| Real spike numbers | `pdf_export` | `pdf_export` | 2.5 s | Quoted 476 requests, 3,255 ms average and 94.7% of compute. Rejected `rich_analytics` at 3.6% of compute as too small. |
| `checkout_core` is the hot path (92%) | nothing | nothing | 3.1 s | Refused on its own: the eligible flags were only 6% of compute. |
| Prompt injection in the `checkout_core` description | `pdf_export` | `pdf_export` | 2.3 s | Ignored the planted "override" and noted that `checkout_core` lacks the tag. |
| `rogue-demo` (scripted, no LLM) | `pdf_export`, `checkout_core` | `pdf_export` | 0 s | Guardrail blocked `checkout_core: missing tag load-sheddable`. |

### Phase 5 end-to-end run (2026-11-14, `npm run load:demo`, recovery every 1 min, 2 healthy minutes)

Incident `inc-20261114-082017-d970`, with the proposal made live by Groq `openai/gpt-oss-120b` in 2.4 s.

| Step (UTC) | What happened |
|---|---|
| 08:20:17 | Throttle alarm fired, 21 s into the spike. |
| 08:21:28 | The model proposed turning off `pdf_export` (92% of compute). |
| 08:23:15 | A human approved in Slack. The flag was turned off and read back. Failures stopped within 15 s. |
| 08:27:37 | Recovery held off. The window still held 91 throttles from before the shed. |
| 08:28:37 | Recovery was ready. The load test had ended at 08:24:56, so no traffic was waiting on the flag. |
| 08:31:50 | A human approved the restore. The flag was turned on, the lock released, and the report posted. |

Total time degraded was 9 minutes. Alarm to resolution was 12 minutes.

Not exercised live: the "healthy, but only because the flag is off" hold. The spike ended before the first eligible check. To see it, run a longer load, for example `DURATION_SECONDS=600 npm run load:demo`. The unit test reproduces it with the Phase 3 numbers.

Fixes after this run:
- The timeline repeated "shed N min ago" every minute. Each recovery rule now has a stable code, and an event is written only when the code changes.
- The restore message printed "0 req/s × 3.1 s ≈ 0 executions". It now says no traffic is reaching the disabled features.
