# Setup and verification

This guide grows phase by phase. It covers **Phase 1** (reports-api, flag seeding, load test), **Phase 2** (alarms, investigator, Slack) and **Phase 3** (approval buttons, executor, real flag flip) **Phase 4** (LLM proposals and the guardrail) and **Phase 5** (recovery and the incident report).

There are two stacks:

| Stack | Contents | Region setting |
|---|---|---|
| `shedpilot` (app) | reports-api, its alarms, the SNS topic | `samconfig.toml` |
| `shedpilot-agent` | incident table, investigator (later also callback, executor, recovery) | `agent/samconfig.toml` |

The agent's region is the one setting to change if the account's Lambda concurrency stays at 10. A second region gives the agent its own concurrency pool, so a spike can't throttle it.

## Prerequisites

- Node.js 22 or newer, AWS CLI v2, AWS SAM CLI
- An AWS account with credentials configured
- A Flagsmith SaaS account with one project and one environment

```bash
npm install                 # root tooling: TypeScript, tsx, esbuild, vitest
npm --prefix backend install
cp .env.example .env        # then fill in the Flagsmith values
```

## 1. Ask AWS for more Lambda concurrency (free, do this first)

Your account's concurrency limit is **10**. AWS refuses any reserved concurrency that would leave fewer than 10 unreserved executions, so the demo's `ReservedConcurrency=5` can't be deployed yet. Requesting a higher quota is free. It's often approved within hours, but can take longer.

```bash
aws service-quotas request-service-quota-increase \
  --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --region ap-south-1

# Check the status later:
aws service-quotas list-requested-service-quota-change-history \
  --service-code lambda --region ap-south-1 \
  --query 'RequestedQuotas[].{Status:Status,Desired:DesiredValue}' --output table
```

Until it's approved, `samconfig.toml` deploys with `ReservedConcurrency=0`, which means no reservation. reports-api then throttles at the account limit of 10 instead of 5. That is enough to verify Phase 1. Phases 2 and 3 need the increase, because otherwise the spike would throttle the agent's own Lambdas too.

## 2. Seed Flagsmith

In the Flagsmith dashboard:
1. Create an organisation API key under Organisation settings, API Access.
2. Create a server-side key for your environment (it starts with `ser.`) under Environment, SDK Keys.
3. Put both keys, the numeric project ID and the environment key into `.env`.

```bash
npm run seed -- --dry-run   # shows what it would create, changes nothing
npm run seed
```

The seed script creates the `load-sheddable` tag and four flags, all enabled by default. Only `pdf_export`, `basic_csv` and `rich_analytics` get the tag. It is safe to run again.

Check three lines in its output:
- **Feature Versioning v2** says whether the executor must use the newer update endpoint.
- **Change requests** must be off. The update endpoint refuses changes when they are on.
- **Checking the flag update endpoint** shows which form of environment key the read-only GET accepts. Please send me these lines. They answer the open question in ARCHITECTURE.md, section 2.3.

## 3. Optional: run the handler locally

```bash
npm run local
curl -s 'http://localhost:3000/api/reports?format=pdf' -o report.pdf && open report.pdf
curl -s 'http://localhost:3000/api/reports/summary' | head -c 300
```

Each request prints one JSON log line in the terminal. Toggle `pdf_export` in the dashboard and request the PDF again. Within 5 seconds you should get the degraded JSON instead.

To measure the raw cost of each feature on your machine:

```bash
npm run bench
```

## 4. Deploy

```bash
./scripts/put-secrets.sh    # copies the keys from .env into SSM as SecureString parameters
npm run deploy:app          # sam build && sam deploy, then confirm the change set
```

Cost: API Gateway, Lambda and CloudWatch Logs for this phase fall within the free tier or cost a few rupees.

The API URL is in the deploy output under `ApiUrl`. The load test finds it on its own.

## 5. Calibrate the PDF cost

Lambda at 512 MB has much less CPU than a laptop. The defaults of 110 pages and 400,000 analytics rows are estimates from local timings. Make one request of each kind, then read the timings from the logs:

```bash
API=$(aws cloudformation describe-stacks --stack-name shedpilot \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "$API/api/reports?format=pdf"
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "$API/api/reports/summary"
aws logs tail /aws/lambda/shedpilot-reports-api --since 5m --format short | grep '"type":"request"'
```

The target is `feature_timings_ms.pdf_export` between 2,000 and 4,000, and `rich_analytics` near 1,000, on warm requests (ignore the first, cold one). Pages scale the cost roughly linearly. To change them, edit `parameter_overrides` in `samconfig.toml`, then run `npm run deploy`. Changing the default in `template.yaml` is not enough: for an existing stack, `sam deploy` keeps each parameter's previous value unless it's passed again.

Warm requests also vary by about 20% between containers, and each container gets a little faster over its first few requests as the JavaScript engine optimises.

## 6. Verify the Phase 1 goal

**a. Healthy baseline.** Expect all routes OK and no throttles.

```bash
npm run load:baseline
```

**b. Spike with `pdf_export` ON.** Expect throttling: failed requests with a 5xx status in the table, and high PDF latency.

```bash
npm run load:spike
```

Then confirm the throttles in CloudWatch:

```bash
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value=shedpilot-reports-api \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Sum --output table
```

**c. Spike with `pdf_export` OFF.** Turn the flag off by hand in the Flagsmith dashboard, then run the spike again. Expect PDF requests to show as *Degraded* with low latency, no failures, and no new throttles.

```bash
npm run load:spike
```

Turn `pdf_export` back on afterwards. A shorter smoke run is available with `DURATION_SECONDS=30 npm run load:spike`.

## 7. Phase 2: alarms, investigator and Slack

Prerequisite: the Slack app from [slack-app-manifest.yaml](slack-app-manifest.yaml), with `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_CHANNEL_ID` in `.env`, and `./scripts/put-secrets.sh` run again.

```bash
npm test                              # unit tests: state machine, evidence query, proposal, Slack layout
npm run deploy:app                    # adds the SNS topic and two alarms (about US$0.20 a month)
npm run deploy:agent                  # incident table + investigator, wired to the alarms
```

**a. Quick check without load.** This forces the throttle alarm. With no recent traffic, Slack should get an "Investigated: no safe action available" message within about 10 seconds.

```bash
./scripts/trigger-alarm.sh
aws logs tail /aws/lambda/shedpilot-investigator --since 5m --format short --region ap-south-1
```

**b. The real thing.** With `pdf_export` on, run the spike. The throttle alarm fires within 1 to 2 minutes. Slack then gets a message with the measured numbers, a proposal to turn off `pdf_export`, and Approve and Reject buttons. The buttons don't do anything until Phase 3.

```bash
npm run load:spike
```

**c. Only one incident at a time.** The second alarm, for latency, fires too, but it only adds an audit event to the open incident. Inspect an incident's record and audit trail:

```bash
aws dynamodb scan --table-name shedpilot-incidents --region ap-south-1 \
  --query 'Items[].{pk:pk.S,sk:sk.S,status:status.S,message:message.S}' --output table
```

An incident waiting for approval keeps the lock until Phase 3 can approve or reject it. To start fresh while testing:

```bash
./scripts/reset-incident.sh
```

## 8. Phase 3: approve in Slack, flip the flag

```bash
npm test
npm run deploy:agent      # adds slack-callback (public URL) and the executor
```

The deploy prints `SlackInteractivityUrl`. Get it again any time with:

```bash
aws cloudformation describe-stacks --stack-name shedpilot-agent --region ap-southeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='SlackInteractivityUrl'].OutputValue" --output text
```

**Connect the buttons to it.** At https://api.slack.com/apps, open **ShedPilot**, then **Interactivity & Shortcuts**. Switch **Interactivity** on, paste the URL into **Request URL**, and click **Save Changes**.

**Rehearse without touching Flagsmith (optional).** Set `DryRun=true`, then approve a proposal. The Slack message will say DRY RUN, and the executor log shows the exact request it would have sent.

```bash
DRY_RUN=true ./scripts/deploy-agent.sh   # not needed for the real run; plain ./scripts/deploy-agent.sh switches back
```

**The real run.** With `pdf_export` on:

1. Run `npm run load:spike`.
2. Wait for the proposal in Slack, about a minute.
3. Click **Approve**, then confirm.

Within a few seconds the message changes to "Approved by you" and "Turned off `pdf_export` in Flagsmith". The load test's progress lines stop showing new failures, because PDF requests now get the fast degraded response.

Check it:

```bash
aws logs tail /aws/lambda/shedpilot-executor --since 10m --format short --region ap-southeast-1
aws dynamodb scan --table-name shedpilot-incidents --region ap-southeast-1 \
  --query 'Items[].{sk:sk.S,status:status.S,message:message.S}' --output table
```

**Safety checks to try:**
- **Double click Approve.** The second click gets "Already handled", visible only to you.
- **Click Reject on a new proposal.** No flag changes, the message says who rejected it, and the incident closes.
- **Approve a proposal older than 30 minutes.** It expires instead, because its evidence is stale.

Afterwards, turn `pdf_export` back on, in the dashboard or with the update command from Phase 1. Phase 5 will propose this automatically. Then run `./scripts/reset-incident.sh` to close the SHED incident.

## 9. Phase 4: the LLM proposes, the guardrail checks

1. Put your Groq key, which starts with `gsk_`, in `.env` as `GROQ_API_KEY=...`. Create it at console.groq.com. The free tier is enough. For a real xAI Grok key, which starts with `xai-`, use `XAI_API_KEY` and deploy with `LlmProvider=xai`.
2. Try the model locally first. This needs no AWS and no Slack, and each run is one or two model calls:

```bash
npm run llm:try                              # the real spike numbers: expect "turn off pdf_export"
npm run llm:try -- --scenario checkout-hot   # checkout_core is the hot path: the guardrail must block it
npm run llm:try -- --scenario no-stress      # nothing wrong: expect no action
```

3. Copy the key to AWS and redeploy:

```bash
./scripts/put-secrets.sh
npm test
npm run deploy:agent
```

4. Run `npm run load:spike`, or `npm run load:demo` for a 5-minute run. Slack shows "Investigating…" straight away. About a minute later, that message turns into the proposal. Its footer now reads "proposed by openai/gpt-oss-120b in N s". If the model proposes anything unsafe, a **Blocked by the guardrail** section lists it and its reason, and it never gets a button.

Without a key, or with `LlmProvider=none`, ShedPilot uses the rule-based proposal and labels it as such.

More local scenarios:

```bash
npm run llm:try -- --scenario injection        # a flag description tries to order the model around
LLM_PROVIDER=rogue-demo npm run llm:try        # scripted misbehaving model: watch the guardrail
```

**Guardrail proof in Slack, for the demo video.** Deploy with the scripted rogue model, run the spike, and the proposal shows **Blocked by the guardrail: checkout_core: missing tag load-sheddable**, with buttons only for `pdf_export`. Switch back afterwards.

```bash
LLM_PROVIDER=rogue-demo ./scripts/deploy-agent.sh
./scripts/deploy-agent.sh                       # back to the real model (groq)
```

## 10. Phase 5: recovery, re-enable, incident report

The recovery Lambda runs on a schedule. The template default is every 10 minutes. For the demo, deploy it to run every minute and to need 2 healthy minutes:

```bash
RECOVERY_EVERY_MINUTES=1 HEALTHY_MINUTES=2 ./scripts/deploy-agent.sh
```

To keep these settings, put the two lines in `.env`. Every later `./scripts/deploy-agent.sh` then uses them.

**The full story in one run.** Start with `pdf_export` on and no open incident (`./scripts/reset-incident.sh`).

| Time into run | What happens |
|---|---|
| 0:00 | You start `npm run load:demo` (5 minutes). |
| ~0:30 | The alarm fires, and Slack shows "Investigating…". |
| ~1:45 | The message turns into the proposal from `openai/gpt-oss-120b`. Click **Approve**. |
| next few seconds | `pdf_export` turns off. The load test's failure count stops rising. |
| until 5:00 | Recovery checks every minute and **does not** propose a restore. The service is healthy, but only because the flag is off: about 6 PDF requests a second are still arriving, and turning it back on would need about 19 executions when about 4 are free. The audit trail records this. |
| ~4 min after the run | The traffic is gone and the service has been healthy for 2 complete minutes, so Slack gets **"reports-api has recovered: turn features back on?"**, with before and after numbers. Click **Approve: turn back on**. |
| a few seconds later | `pdf_export` is on again, the incident is RESOLVED, and Slack gets the **incident report**: time degraded, who approved what, the measured cause, and the timeline. |

Click **Keep disabled** instead, and ShedPilot waits `RESTORE_COOLDOWN_MINUTES` (default 10) before asking again.

Watch the recovery checks:

```bash
aws logs tail /aws/lambda/shedpilot-recovery --follow --format short --region ap-southeast-1 | grep 'Recovery check'
```

A shedding proposal nobody acts on for 30 minutes expires automatically. Its Slack message says so, and the lock is released.

## Teardown

```bash
./scripts/teardown.sh
```

It deletes both stacks, agent first, including the Lambdas, the API, the alarms, the SNS topic, the incident table and the log groups. It also removes all `/shedpilot/*` SSM parameters. The SAM artifact bucket is shared with your other SAM projects and is left in place.
