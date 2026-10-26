#!/usr/bin/env bash
# (Re)deploys this checkout to Cloudflare Workers. Idempotent: run it for the first deploy (after
# scripts/cloudflare-setup.sh) and after every `git pull`. All deployment state lives outside git
# (.env.production, the credentials file, local/), so pulling never touches it.
#
#   1. shows what changed since the last deploy
#   2. installs dependencies, runs `pnpm run doctor` and stops if anything is missing or wrong
#   3. builds the web app and production Worker from .env.production
#   4. notes a D1 Time Travel bookmark (restore point), then applies D1 migrations
#   5. uploads the roster and its avatars (DIRECTORY_SOURCE=roster)
#   6. deploys the Worker with its secrets and records the successful deployment
set -euo pipefail
export DO_NOT_TRACK=1 CF_SEND_TELEMETRY=false WRANGLER_SEND_METRICS=false
cd "$(dirname "$0")/.."

conf() { node scripts/config.ts get "$1" --raw; }

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
export CI=1 # no interactive prompts from Cloudflare tools

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
echo "==> pnpm install"
pnpm install --frozen-lockfile
echo "==> doctor"
if ! node scripts/config.ts doctor; then
  echo "Fix the problems above (pnpm run config set KEY VALUE), then re-run scripts/deploy.sh." >&2
  exit 1
fi

# 3. Build
echo "==> build"
node scripts/build-web.ts
pnpm exec cf build --mode production
DATABASE_ID="$(conf D1_DATABASE_ID)"

# 4. Database
BOOKMARK="$(pnpm exec cf d1 time-travel get-bookmark "$DATABASE_ID" 2>/dev/null | jq -r '.bookmark // .result.bookmark // empty' || true)"
[[ -n "$BOOKMARK" ]] && echo "==> D1 restore point before this deploy: $BOOKMARK"
echo "==> D1 migrations"
pnpm exec cf d1 migrations apply "$DATABASE_ID" --dir migrations

# 5. Roster
if [[ "$(node -e 'import { directorySourceOf } from "./src/server/settings.ts"; import { fileValues } from "./scripts/lib/env.ts"; console.log(directorySourceOf(fileValues()))')" == "roster" ]]; then
  echo "==> roster"
  node scripts/push-roster.ts
fi

# 6. Worker
echo "==> cf deploy"
SECRETS="$(node scripts/config.ts secrets-file)"
trap '[[ -n "${SECRETS:-}" ]] && rm -f "$SECRETS"' EXIT
pnpm exec cf deploy --mode production --prebuilt --no-provision ${SECRETS:+--secrets-file "$SECRETS"}

echo "$COMMIT $(date -Iseconds) ${BOOKMARK:-}" >"$STATE"
echo "==> Deployed $COMMIT to $PUBLIC_URL (Worker $NAME)"
