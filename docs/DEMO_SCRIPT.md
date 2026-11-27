# ShedPilot Demo Video Script (3.5–4 Minutes)

Target runtime: **3 min 45 s** (speed up the 60 s CloudWatch settle wait and the recovery health window in video editing).

## Pre-Recording Checklist

1. Ensure all 4 flags are **ON** in Flagsmith (`npm run seed -- --dry-run`) and no incident lock is open (`./scripts/reset-incident.sh`).
2. Deploy with fast demo recovery (`RECOVERY_EVERY_MINUTES=1 HEALTHY_MINUTES=2 ./scripts/deploy-agent.sh`).
3. Open 4 windows side by side or ready to switch:
   - **Terminal 1**: Load test (`npm run load:demo`)
   - **Terminal 2**: Live `reports-api` / `executor` logs or Flagsmith CLI (`flagsmith eval pdf_export` / `curl`)
   - **Browser**: Flagsmith Dashboard (Development environment flags list)
   - **Slack**: `#shedpilot` channel

---

## Shot List

| Time | Shot | What is on screen | Voiceover / Key Points |
|---|---|---|---|
| **0:00 – 0:25** | **1. The Problem & Setup** | Show [Flagsmith Dashboard](https://app.flagsmith.com) with `pdf_export`, `basic_csv`, `rich_analytics` (tagged `load-sheddable`) and `checkout_core` (untagged). Show architecture diagram in `README.md`. | "In serverless apps, one heavy feature can starve critical routes like checkout when Lambda hits its concurrency limit. ShedPilot is an AI SRE agent that measures which Flagsmith flag caused the overload, proposes the smallest safe shed, waits for human approval in Slack, and later restores it." |
| **0:25 – 0:50** | **2. Healthy Baseline** | Terminal 1 runs `npm run load:baseline` (or show recent baseline output: 0 failures, fast responses). Show `/api/checkout` returning `200 OK`. | "Under normal traffic, all four endpoints—including PDF export and checkout—succeed with zero throttling." |
| **0:50 – 1:25** | **3. Traffic Spike & Collateral Damage** | Terminal 1 starts `npm run load:demo`. Progress lines start showing rising `failed` counts (`503` throttles). Explain that `pdf_export` is doing real `pdfkit` CPU work (~3.5 s per call), starving `/api/checkout`. | "Now we hit the API with an open-loop spike of 8 requests per second, mostly PDF exports. Because `pdf_export` takes ~3.5 seconds of real CPU per request, all 10 Lambda concurrency slots fill up and `/api/checkout` gets throttled with 503s." |
| **1:25 – 2:00** | **4. Alarm & Evidence-Backed Investigation** | Slack immediately shows `:mag: Investigating reports-api`. *(Speed up ~60 s settle wait in edit.)* The message updates in place to `:rotating_light: reports-api is overloaded` with CloudWatch metrics, the Logs Insights feature compute table (`pdf_export ~94%`), diagnosis from `openai/gpt-oss-120b`, and **Approve / Reject** buttons. | "CloudWatch fires the throttle alarm. ShedPilot claims an atomic DynamoDB lock so duplicate alarms don't spam Slack, queries CloudWatch Metrics and Logs Insights, and asks the LLM for the minimum action. Notice it doesn't disable everything—it quotes exact numbers showing `pdf_export` used over 90% of compute, while leaving `rich_analytics` and `basic_csv` alone." |
| **2:00 – 2:30** | **5. Human Approval & Real Flagsmith Flip** | Click **Approve** -> **Turn off** in Slack. Ephemeral reply confirms `"Approval recorded..."`. Within seconds, Slack updates to `:white_check_mark: reports-api: load shed`. Switch to Terminal 1: `failed` counter freezes immediately! Switch to Flagsmith Dashboard (or Flagsmith MCP/CLI): `pdf_export` is now **OFF**. | "Nothing changes in Flagsmith until a human approves. Clicking Approve verifies Slack's HMAC signature, writes `APPROVED` atomically in DynamoDB, and triggers the executor. Within seconds, `pdf_export` is flipped off via the Flagsmith Admin API, read back to verify, and `/api/reports?format=pdf` immediately returns a fast 50 ms degraded JSON response—saving checkout." |
| **2:30 – 3:00** | **6. Guardrail Proof (`rogue-demo`)** | Cut to a pre-recorded or second run with `LLM_PROVIDER=rogue-demo` (or show the Slack screenshot / live run) where the scripted rogue model tries to disable `checkout_core`. Point to `:shield: Blocked by the guardrail: checkout_core: missing tag load-sheddable` and show no button exists for `checkout_core`. | "What if the LLM hallucinates or tries to turn off `checkout_core`? Here's our simulated rogue model proposing both `pdf_export` and `checkout_core`. Deterministic code enforces the `load-sheddable` tag both at proposal time and again before execution—so `checkout_core` is blocked and never even gets an approval button." |
| **3:00 – 3:40** | **7. Safe Recovery & Incident Report** | *(Speed up the ~3–4 min cooldown after load stops.)* Show recovery logs holding off while traffic is still arriving (`"healthy, but only because the flag is off"`), then Slack posting `:seedling: reports-api has recovered: turn features back on?` with before/after metrics and Little's law demand check. Click **Approve: turn back on**. Slack updates to `features restored` and posts the `:clipboard: Incident report` with timeline and approvers. | "Recovery doesn't blindly re-enable when latency drops—it checks Logs Insights demand on the disabled route so turning the flag back on won't immediately re-trigger the outage. Once traffic clears, ShedPilot proposes restoring `pdf_export`, a human approves, Flagsmith flips it back on, and ShedPilot posts the full audit report." |

---

## Post-Demo Cleanup

```bash
./scripts/reset-incident.sh   # if any test incident lock remains
npm run seed                  # ensure all demo flags are restored to default state
./scripts/teardown.sh         # when completely finished, to remove all AWS resources
```

