---
name: production-app-deploy
description: Use this skill when deploying this claude-code-hub project to production, testing production safely, replacing the app Docker image, restarting only the app container, or performing rollback-aware smoke checks on coding.colwzq.top. It covers local validation, image build/load, production override updates, health checks, and immediate rollback rules.
---

# Production App Deploy

## Scope

Use this for production app-only deploys of `claude-code-hub` serving
`https://coding.colwzq.top`.

Do not use this for database migrations, Redis changes, Caddy changes, MinIO changes, audit-worker
changes, or destructive cleanup unless the user explicitly asks for that broader operation.

## Production Facts

Read `AGENTS.md` first, then verify these facts before acting because production details can drift.

- Production host: `ubuntu@106.54.22.99`
- Production compose path: `/www/compose/claude-code-hub`
- Production app container: `claude-code-hub-app-qzie`
- Production DB container: `claude-code-hub-db-qzie`
- Production Redis container: `claude-code-hub-redis-qzie`
- Production app override: `artifacts/docker-compose.model-market-copy.override.yaml`
- Normal deploy target: app only. Do not restart Postgres, Redis, Caddy, MinIO, or audit-worker.

Never print full API keys, admin tokens, DB passwords, Redis URLs, or production `.env` contents.

## Required Plan

Create and maintain a todo list for every production deploy:

1. Confirm local toolchain and dirty worktree.
2. Run local validation.
3. Build a new Docker image.
4. Record production rollback state.
5. Load the image onto production.
6. Update the app override and restart only app with auto-rollback.
7. Run health and smoke checks.
8. Report results and rollback state.

Stop before production changes if local build or targeted tests fail.

## Local Validation

Use Bun from the user's shell:

```bash
source ~/.zshrc >/dev/null 2>&1 || true
bun --version
git status --short
bun run typecheck
```

Run scoped Biome on changed files. Full `bun run lint` may fail on existing unrelated diagnostics; if it
does, state that clearly and still run scoped Biome for touched files.

Run targeted tests for the change. For my-usage changes, use a local test DB, never production:

```bash
ADMIN_TOKEN="$ADMIN_TOKEN" \
DSN="postgres://postgres:postgres@127.0.0.1:5432/claude_code_hub_test" \
bun run test:coverage:my-usage
```

Then run:

```bash
bun run build
```

Only continue if targeted tests and build pass.

## Image Build

Use a descriptive, dated local image tag:

```bash
IMAGE="claude-code-hub:<short-purpose>-$(date +%Y%m%d)"
docker build -t "$IMAGE" -f Dockerfile .
docker image inspect "$IMAGE" --format 'id={{.Id}} size={{.Size}} created={{.Created}}'
```

Do not push to a registry unless the user explicitly requests it. Prefer `docker save | ssh docker load`
for this host.

## Record Rollback State

Before changing production, record the current app image, image ID, override checksum, and override
contents:

```bash
ssh ubuntu@106.54.22.99 '
  set -e
  cd /www/compose/claude-code-hub
  echo "running_image=$(sudo -n docker ps --filter name=claude-code-hub-app-qzie --format "{{.Image}}")"
  echo "running_id=$(sudo -n docker inspect claude-code-hub-app-qzie --format "{{.Image}}")"
  echo "override_sha=$(sha256sum artifacts/docker-compose.model-market-copy.override.yaml | awk "{print \$1}")"
  sed -n "1,40p" artifacts/docker-compose.model-market-copy.override.yaml
'
```

If `sudo -n` fails, stop and ask the user for the correct access path.

## Load Image

Load the already-built image onto production without writing a large tar file there:

```bash
docker save "$IMAGE" | gzip -1 | ssh ubuntu@106.54.22.99 "gzip -dc | sudo -n docker load"
```

This does not change running traffic.

## App-Only Restart With Auto-Rollback

Use a single remote script that:

- Backs up the override file.
- Writes the new app image.
- Runs `docker compose config`.
- Runs `docker compose ... up -d --no-deps app`.
- Waits for `claude-code-hub-app-qzie` to become `running healthy`.
- If compose or health fails, writes the old image back and restarts only app.

Template:

```bash
ssh ubuntu@106.54.22.99 'bash -s' <<'REMOTE'
set -euo pipefail
cd /www/compose/claude-code-hub
OLD_IMAGE='<old-image-tag>'
NEW_IMAGE='<new-image-tag>'
OVERRIDE='artifacts/docker-compose.model-market-copy.override.yaml'
BACKUP="${OVERRIDE}.bak-$(date +%Y%m%d-%H%M%S)"

write_override() {
  local image="$1"
  printf 'services:\n  app:\n    image: %s\n' "$image" | sudo -n tee "$OVERRIDE" >/dev/null
}

wait_healthy() {
  local label="$1"
  for i in $(seq 1 60); do
    local state
    state=$(sudo -n docker inspect claude-code-hub-app-qzie --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}} {{.Config.Image}}' 2>/dev/null || true)
    echo "${label}_health_check_${i}: ${state}"
    case "$state" in
      "running healthy "*) return 0 ;;
      "exited "*|"dead "*) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

rollback() {
  echo "ROLLBACK: switching app back to ${OLD_IMAGE}"
  write_override "$OLD_IMAGE"
  sudo -n docker compose -f docker-compose.yaml -f "$OVERRIDE" up -d --no-deps app
  wait_healthy rollback || true
}

trap 'echo "DEPLOY_ERROR"; rollback' ERR

sudo -n cp -a "$OVERRIDE" "$BACKUP"
echo "backup=${BACKUP}"
write_override "$NEW_IMAGE"
sudo -n docker compose -f docker-compose.yaml -f "$OVERRIDE" config >/tmp/claude-code-hub-compose-check.yaml
sudo -n docker compose -f docker-compose.yaml -f "$OVERRIDE" up -d --no-deps app

if ! wait_healthy deploy; then
  echo "DEPLOY_HEALTH_FAILED"
  rollback
  exit 1
fi

trap - ERR
echo "DEPLOY_HEALTH_OK"
sudo -n docker ps --filter name=claude-code-hub-app-qzie --format 'app={{.Names}} image={{.Image}} status={{.Status}}'
REMOTE
```

Do not proceed to final success messaging until smoke checks pass.

## Smoke Checks

Run public health:

```bash
curl -fsS -o /tmp/cch-health.json -w 'health_status=%{http_code}\n' \
  https://coding.colwzq.top/api/health
```

Run a readonly login + my-usage API smoke without printing the key. Store the selected key only in a
remote shell variable and delete temporary files:

```bash
ssh ubuntu@106.54.22.99 'bash -s' <<'REMOTE'
set -euo pipefail
KEY=$(sudo -n docker exec claude-code-hub-db-qzie sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select k.key from keys k join users u on u.id = k.user_id join message_request mr on mr.key = k.key where k.deleted_at is null and k.is_enabled = true and u.deleted_at is null and u.is_enabled = true and mr.deleted_at is null and (mr.blocked_by is null or mr.blocked_by <> '\''warmup'\'') order by case when k.can_login_web_ui = false then 0 else 1 end, mr.created_at desc limit 1"')
export KEY
python3 - <<'PY' >/tmp/cch-login-body.json
import json, os, sys
json.dump({"key": os.environ["KEY"]}, sys.stdout)
PY
LOGIN_STATUS=$(curl -sS -c /tmp/cch-smoke-cookies.txt -b /tmp/cch-smoke-cookies.txt -o /tmp/cch-login-smoke.json -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @/tmp/cch-login-body.json https://coding.colwzq.top/api/auth/login)
MY_STATUS=$(curl -sS -c /tmp/cch-smoke-cookies.txt -b /tmp/cch-smoke-cookies.txt -o /tmp/cch-myusage-smoke.json -w '%{http_code}' -H 'Content-Type: application/json' -d '{"limit":5}' https://coding.colwzq.top/api/actions/my-usage/getMyUsageLogsBatchFull)
LOGIN_STATUS="$LOGIN_STATUS" MY_STATUS="$MY_STATUS" python3 - <<'PY'
import json, os
login = json.load(open('/tmp/cch-login-smoke.json', encoding='utf-8'))
body = json.load(open('/tmp/cch-myusage-smoke.json', encoding='utf-8'))
logs = body.get('data', {}).get('logs', []) if isinstance(body, dict) else []
sensitive = ('providerName', 'providerChain', 'errorMessage', 'blockedBy', 'blockedReason', 'userAgent', 'messagesCount', '_liveChain')
clean = all(all(log.get(field) in (None, '') for field in sensitive) for log in logs)
print(f"login_status={os.environ['LOGIN_STATUS']} ok={login.get('ok')} loginType={login.get('loginType')} redirectTo={login.get('redirectTo')}")
print(f"my_usage_status={os.environ['MY_STATUS']} ok={body.get('ok')} logs={len(logs)} breakdown_logs={sum(1 for log in logs if log.get('costBreakdown') is not None)} multiplier_logs={sum(1 for log in logs if log.get('costMultiplier') is not None or log.get('groupCostMultiplier') is not None)} sensitive_clean={clean}")
PY
rm -f /tmp/cch-login-body.json /tmp/cch-login-smoke.json /tmp/cch-myusage-smoke.json /tmp/cch-smoke-cookies.txt
REMOTE
```

For page route checks, use locale-prefixed routes. `/my-usage` may be 404 in the current i18n setup;
`/zh-CN/my-usage` and `/en/my-usage` should return 200 after login.

Check recent app logs for startup failures:

```bash
ssh ubuntu@106.54.22.99 \
  "sudo -n docker logs --since=3m claude-code-hub-app-qzie 2>&1 | grep -Ei 'error|exception|unhandled|SESSION_CREATE_FAILED|database connection failed|Redis.*failed' | tail -80 || true"
```

Transient `Failed to find Server Action` messages immediately after deploy can be old browser tabs
calling old action IDs. Treat them as suspicious only if they persist with new page loads or health/smoke
fails.

## Final Report

Report:

- New image tag.
- Old image tag and override backup path.
- What was restarted.
- Local checks and their results.
- Health and smoke outputs.
- Whether rollback was needed.
- Any known caveats, especially full-repo lint failures unrelated to touched files.
