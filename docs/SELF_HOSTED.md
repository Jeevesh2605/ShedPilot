# Self-Hosting Flagsmith with ShedPilot (Track 3)

ShedPilot works against either **Flagsmith Cloud** or **self-hosted open-source Flagsmith** using one environment variable: `FLAGSMITH_API_HOST`.

When `FLAGSMITH_API_HOST` is empty, `reports-api` and the agent Lambdas default to Flagsmith Cloud. When `FLAGSMITH_API_HOST` is set (for example `https://<your-tunnel>.trycloudflare.com`), the entire stack—flag seeding, SDK evaluation, Admin inventory reads, and executor flag toggles (both v1 `featurestates` and v2 `__future__` environments)—targets your self-hosted Flagsmith instance.

---

## Option A: Local Docker Compose + Cloudflare Tunnel (Recommended for Demo)

### 1. Start Open-Source Flagsmith locally

```bash
docker compose -f self-hosted/docker-compose.yml up -d
```

Wait ~20 seconds for migrations to finish, then open **`http://localhost:8000`** and create your admin account, organisation, project, and environment.

### 2. Expose port `8000` with HTTPS for AWS Lambdas

Because `reports-api` (`ap-south-1`) and `shedpilot-agent` (`ap-southeast-1`) run in AWS Lambda, expose your local Flagsmith port `8000` via Cloudflare Quick Tunnel (free, no account needed):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8000
```

Copy the printed `https://<random-subdomain>.trycloudflare.com` URL.

### 3. Configure `.env` and seed your self-hosted Flagsmith

In the self-hosted Flagsmith UI (`http://localhost:8000`):
1. **Organisation Settings → API Access → Create API Key** → copy to `FLAGSMITH_ADMIN_API_KEY`.
2. **Project URL** (`.../project/<ID>/...`) → copy numeric ID to `FLAGSMITH_PROJECT_ID`.
3. **Environment → SDK Keys**:
   - Copy the Client-side Environment Key to `FLAGSMITH_ENVIRONMENT_KEY`.
   - Create a **Server-side Environment Key** (`ser.xxx`) and copy to `FLAGSMITH_SERVER_KEY`.
4. Set `FLAGSMITH_API_HOST=https://<random-subdomain>.trycloudflare.com` in `.env`.

Verify connectivity and seed the `load-sheddable` tag + 4 demo flags:

```bash
npm run seed -- --dry-run
npm run seed
```

### 4. Push the new server key to SSM and deploy both stacks

```bash
./scripts/put-secrets.sh
./scripts/deploy-app.sh --no-confirm-changeset
./scripts/deploy-agent.sh --no-confirm-changeset
```

### 5. Run the demo against your self-hosted Flagsmith

```bash
npm run load:demo
```

Watch the alarm fire, approve in Slack, and watch `pdf_export` flip **OFF** live inside your local Flagsmith dashboard (`http://localhost:8000`).

### 6. Switch back to Flagsmith Cloud (any time)

Comment out or clear `FLAGSMITH_API_HOST=` in `.env`, restore your Cloud keys in `.env`, and re-run `./scripts/put-secrets.sh`, `./scripts/deploy-app.sh --no-confirm-changeset`, and `./scripts/deploy-agent.sh --no-confirm-changeset`.

To stop the local Flagsmith containers:

```bash
docker compose -f self-hosted/docker-compose.yml down
```

