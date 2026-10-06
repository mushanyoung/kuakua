#!/usr/bin/env bash
# (Re)deploys this checkout as a systemd service. Idempotent: run it for the first deploy and
# after every `git pull`. All deployment state lives outside git (.env.production, local/,
# DATA_DIR), so pulling never touches it.
#
#   1. shows what changed since the last deploy
#   2. installs dependencies
#   3. runs `bun run doctor` and stops if anything required is missing or wrong
#   4. backs up the database (schema migrations run automatically on start)
#   5. installs / refreshes the systemd unit from deploy/kuakua.service.in
#   6. restarts the service and waits for /healthz
#
# Needs sudo for systemctl and /etc/systemd/system.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

conf() { bun scripts/config.ts get "$1" --raw; }

if [[ ! -f .env.production ]]; then
  echo "No .env.production yet. Configure the deployment first (AGENTS.md → first deployment)." >&2
  exit 1
fi

SERVICE="$(conf SERVICE_NAME)"
PORT="$(conf PORT)"
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
  fi
else
  echo "==> First deploy of $COMMIT"
fi

# 2. Dependencies
echo "==> bun install"
bun install --frozen-lockfile

# 3. Configuration
echo "==> doctor"
if ! bun scripts/config.ts doctor; then
  echo "Fix the problems above (bun run config set KEY VALUE), then re-run scripts/deploy.sh." >&2
  exit 1
fi

# 4. Backup
echo "==> backup"
bun scripts/backup.ts "$COMMIT"

# 5. systemd unit
BUN="$(bun -e 'console.log(process.execPath)')"
UNIT="/etc/systemd/system/$SERVICE.service"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed -e "s|@USER@|$(id -un)|g" -e "s|@GROUP@|$(id -gn)|g" -e "s|@DIR@|$ROOT|g" \
  -e "s|@BUN@|$BUN|g" -e "s|@PUBLIC_URL@|$PUBLIC_URL|g" deploy/kuakua.service.in | grep -v '^#' >"$rendered"
if ! cmp -s "$rendered" "$UNIT" 2>/dev/null; then
  echo "==> installing $UNIT"
  sudo install -m 644 "$rendered" "$UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE" >/dev/null 2>&1
fi

# 6. Restart and wait for health
echo "==> restarting $SERVICE"
since="$(date '+%Y-%m-%d %H:%M:%S')"
sudo systemctl restart "$SERVICE"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    sleep 1
    if systemctl is-active --quiet "$SERVICE"; then
      echo "$COMMIT $(date -Iseconds)" >"$STATE"
      sudo journalctl -u "$SERVICE" --since "$since" --no-pager -o cat | tail -n 5 | sed 's/^/    /'
      echo "==> Deployed $COMMIT to $PUBLIC_URL (service $SERVICE, port $PORT)"
      exit 0
    fi
  fi
  sleep 1
done
echo "!! $SERVICE did not become healthy. Recent log:" >&2
sudo journalctl -u "$SERVICE" --since "$since" --no-pager -o cat | tail -n 40 >&2
exit 1
