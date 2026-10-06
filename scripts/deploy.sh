#!/usr/bin/env bash
# (Re)deploys this checkout to Cloudflare Workers. Idempotent: run it for the first deploy (after
# scripts/cloudflare-setup.sh) and after every `git pull`. All deployment state lives outside git
# (.env.production, the credentials file, local/), so pulling never touches it.
#
#   1. shows what changed since the last deploy
#   2. installs dependencies, runs `bun run doctor` and stops if anything is missing or wrong
#   3. builds the web app and writes local/wrangler.json from .env.production
#   4. notes a D1 Time Travel bookmark (restore point), then applies D1 migrations
#   5. uploads the roster and its avatars (DIRECTORY_SOURCE=roster)
#   6. deploys the Worker with its secrets, and waits until https://<host>/healthz runs the new code
set -euo pipefail
cd "$(dirname "$0")/.."

conf() { bun scripts/config.ts get "$1" --raw; }

if [[ ! -f .env.production ]]; then
  echo "No .env.production yet. Configure the deployment first (AGENTS.md → first deployment)." >&2
  exit 1
fi

CF_FILE="${CLOUDFLARE_ENV_FILE:-$(conf CLOUDFLARE_ENV_FILE)}"
if [[ -f "$CF_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CF_FILE"
  set +a
fi
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export CI=1 # no interactive prompts from wrangler

NAME="$(conf WORKER_NAME)"
PUBLIC_URL="$(conf PUBLIC_URL)"
COMMIT="$(git rev-parse --short HEAD)"
STATE=local/last-deploy
mkdir -p local

# 1. What's new
if [[ -f "$STATE" ]]; then
  prev="$(cut -d' ' -f1 "$STATE")"
  if [[ "$prev" == "$COMMIT" ]]; then
    echo "==> Redeploying $COMMIT (unchanged since the last deploy)"
  elif git cat-file -e "$prev^{commit}" 2>/dev/null; then
    echo "==> Changes since the last deploy ($prev → $COMMIT):"
    git log --oneline "$prev..HEAD" | sed 's/^/    /'
    if ! git diff --quiet "$prev" HEAD -- src/server/settings.ts; then
      echo "    ! settings changed (src/server/settings.ts) — doctor below lists anything to review"
    fi
    if ! git diff --quiet "$prev" HEAD -- migrations; then
      echo "    ! database migrations changed — they're applied below"
    fi
  fi
else
  echo "==> First deploy of $COMMIT"
fi

# 2. Dependencies and configuration
echo "==> bun install"
bun install --frozen-lockfile
echo "==> doctor"
if ! bun scripts/config.ts doctor; then
  echo "Fix the problems above (bun run config set KEY VALUE), then re-run scripts/deploy.sh." >&2
  exit 1
fi

# 3. Build
echo "==> build"
bun scripts/build-web.ts
CONFIG="$(bun scripts/config.ts wrangler-config)"

# 4. Database
BOOKMARK="$(bunx wrangler d1 time-travel info "$NAME" --json -c "$CONFIG" 2>/dev/null | jq -r '.bookmark // empty' || true)"
[[ -n "$BOOKMARK" ]] && echo "==> D1 restore point before this deploy: $BOOKMARK"
echo "==> D1 migrations"
bunx wrangler d1 migrations apply "$NAME" --remote -c "$CONFIG"

# 5. Roster
if [[ "$(bun -e 'import { directorySourceOf } from "./src/server/settings"; import { fileValues } from "./scripts/lib/env"; console.log(directorySourceOf(fileValues()))')" == "roster" ]]; then
  echo "==> roster"
  bun scripts/push-roster.ts
fi

# 6. Worker
echo "==> wrangler deploy"
SECRETS="$(bun scripts/config.ts secrets-file)"
trap '[[ -n "${SECRETS:-}" ]] && rm -f "$SECRETS"' EXIT
bunx wrangler deploy -c "$CONFIG" ${SECRETS:+--secrets-file "$SECRETS"}

echo "==> waiting for $PUBLIC_URL to serve $COMMIT"
for _ in $(seq 1 60); do
  live="$(curl -fsS -o /dev/null -D - "$PUBLIC_URL/healthz" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "x-kuakua-version" {print $2}')"
  if [[ "$live" == "$COMMIT" ]]; then
    echo "$COMMIT $(date -Iseconds) ${BOOKMARK:-}" >"$STATE"
    echo "==> Deployed $COMMIT to $PUBLIC_URL (Worker $NAME)"
    exit 0
  fi
  sleep 3
done
echo "!! $PUBLIC_URL/healthz isn't serving $COMMIT yet (got: ${live:-nothing}). Check: bunx wrangler tail -c $CONFIG" >&2
exit 1
