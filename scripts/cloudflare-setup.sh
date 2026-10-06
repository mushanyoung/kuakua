#!/usr/bin/env bash
# Idempotently prepares the Cloudflare account for this deployment (PUBLIC_URL):
#   1. checks the Zero Trust organization (its team domain is the sign-in page)
#   2. D1 database <WORKER_NAME>            (created in DATA_LOCATION if missing)
#   3. R2 bucket <WORKER_NAME>-files        (avatars and the uploaded roster)
#   4. an Access policy "kuakua: <hostname>" allowing ADMIN_EMAILS, ALLOWED_EMAIL_DOMAINS and,
#      for DIRECTORY_SOURCE=roster, everyone in the roster (re-run after changing any of those)
#   5. the Access app for <hostname> (created with that policy) and a public bypass for /healthz;
#      an existing app that uses other policies is left as it is
#   6. writes CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and D1_DATABASE_ID into .env.production
# The Worker and its Custom Domain are created by scripts/deploy.sh. A Custom Domain can't take
# a hostname that still has a DNS record (e.g. the CNAME of an old tunnel setup): this script
# reports it, and with --replace-dns deletes it — the old site is offline from then until
# scripts/deploy.sh finishes.
#
# Settings come from .env.production; credentials from the file named by CLOUDFLARE_ENV_FILE
# (default .env.cloudflare, never committed): CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
# Token permissions: see AGENTS.md.
set -euo pipefail
cd "$(dirname "$0")/.."

REPLACE_DNS=0
[[ "${1:-}" == "--replace-dns" ]] && REPLACE_DNS=1

conf() { bun scripts/config.ts get "$1" --raw; }
for tool in curl jq bun; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done

CF_FILE="${CLOUDFLARE_ENV_FILE:-$(conf CLOUDFLARE_ENV_FILE)}"
if [[ -f "$CF_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CF_FILE"
  set +a
fi
: "${CLOUDFLARE_API_TOKEN:?missing; put it in $CF_FILE}" "${CLOUDFLARE_ACCOUNT_ID:?missing; put it in $CF_FILE}"

PUBLIC_URL="$(conf PUBLIC_URL)"
HOST="${PUBLIC_URL#https://}"
HOST="${HOST%%/*}"
[[ -n "$HOST" && "$PUBLIC_URL" == https://* ]] || { echo "PUBLIC_URL must be https://<hostname>" >&2; exit 1; }
NAME="$(conf WORKER_NAME)"
BUCKET="$NAME-files"
LOCATION="$(conf DATA_LOCATION)"
APP_NAME="夸夸 Kuakua ($HOST)"
POLICY_NAME="kuakua: $HOST"
API="https://api.cloudflare.com/client/v4"
ACCT="$API/accounts/$CLOUDFLARE_ACCOUNT_ID"

cf() {
  local method="$1" url="$2" data="${3:-}" out
  out="$(curl -sS -X "$method" "$url" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" ${data:+--data "$data"})"
  if [[ "$(jq -r .success <<<"$out")" != "true" ]]; then
    echo "Cloudflare API $method $url failed: $(jq -c '.errors // .' <<<"$out")" >&2
    exit 1
  fi
  echo "$out"
}

# 1. Zero Trust organization
TEAM_DOMAIN="$(cf GET "$ACCT/access/organizations" | jq -r '.result.auth_domain // empty')" || true
if [[ -z "$TEAM_DOMAIN" ]]; then
  echo "This account has no Cloudflare Zero Trust organization yet. Open the Zero Trust dashboard once," >&2
  echo "pick a team name, and add a login method (Settings → Authentication; One-time PIN works), then re-run." >&2
  exit 1
fi
echo "access: team domain $TEAM_DOMAIN" >&2

# 2. D1
DB_ID="$(cf GET "$ACCT/d1/database?name=$NAME" | jq -r --arg n "$NAME" '[.result[] | select(.name == $n)][0].uuid // empty')"
if [[ -z "$DB_ID" ]]; then
  body="$(jq -n --arg n "$NAME" --arg l "$LOCATION" '{name: $n} + (if $l == "" then {} else {primary_location_hint: $l} end)')"
  DB_ID="$(cf POST "$ACCT/d1/database" "$body" | jq -r .result.uuid)"
  echo "d1: created $NAME ($DB_ID)${LOCATION:+ in $LOCATION}" >&2
else
  echo "d1: $NAME exists ($DB_ID)" >&2
fi

# 3. R2
if cf GET "$ACCT/r2/buckets?name_contains=$BUCKET" | jq -e --arg b "$BUCKET" '.result.buckets[] | select(.name == $b)' >/dev/null; then
  echo "r2: $BUCKET exists" >&2
else
  body="$(jq -n --arg n "$BUCKET" --arg l "$LOCATION" '{name: $n} + (if $l == "" then {} else {locationHint: $l} end)')"
  cf POST "$ACCT/r2/buckets" "$body" >/dev/null
  echo "r2: created $BUCKET${LOCATION:+ in $LOCATION}" >&2
fi

# 4 + 5. Access app for the hostname, guarded by a policy this script manages. An app that
# already exists with other policies (set up by hand or by an older version) is left alone.
apps="$(cf GET "$ACCT/access/apps?per_page=500")"
app="$(jq -c --arg d "$HOST" '[.result[] | select(.domain == $d)][0] // empty' <<<"$apps")"
policy_id="$(cf GET "$ACCT/access/policies?per_page=500" | jq -r --arg n "$POLICY_NAME" '[.result[] | select(.name == $n)][0].id // empty')"
if [[ -n "$app" ]] && ! jq -e --arg pid "$policy_id" '$pid != "" and (.policies // [] | map(.id) | index($pid))' <<<"$app" >/dev/null; then
  echo "access: app for $HOST exists ($(jq -r .id <<<"$app")) with its own policies ($(jq -r '[.policies[]?.name] | join(", ")' <<<"$app")); leaving them as they are" >&2
else
  include="$(bun scripts/config.ts access-include)"
  [[ "$(jq length <<<"$include")" -gt 0 ]] || { echo "Nobody would be allowed in: set ADMIN_EMAILS / ALLOWED_EMAIL_DOMAINS / a roster" >&2; exit 1; }
  policy_body="$(jq -n --arg n "$POLICY_NAME" --argjson inc "$include" '{name: $n, decision: "allow", include: $inc, session_duration: "24h"}')"
  if [[ -n "$policy_id" ]]; then
    cf PUT "$ACCT/access/policies/$policy_id" "$policy_body" >/dev/null
    echo "access: updated policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
  else
    policy_id="$(cf POST "$ACCT/access/policies" "$policy_body" | jq -r .result.id)"
    echo "access: created policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
  fi
  if [[ -z "$app" ]]; then
    idps="$(cf GET "$ACCT/access/identity_providers" | jq -c '[.result[].id]')"
    [[ "$idps" != "[]" ]] || echo "access: warning — no login methods configured; add One-time PIN in Zero Trust → Settings → Authentication" >&2
    body="$(jq -n --arg name "$APP_NAME" --arg d "$HOST" --argjson idps "$idps" --arg pid "$policy_id" '{
      name: $name, type: "self_hosted", domain: $d, session_duration: "24h",
      app_launcher_visible: true, allowed_idps: $idps, auto_redirect_to_identity: false,
      policies: [{id: $pid, precedence: 1}]
    }')"
    app="$(cf POST "$ACCT/access/apps" "$body" | jq -c .result)"
    echo "access: created app $(jq -r .id <<<"$app")" >&2
  else
    echo "access: app for $HOST exists $(jq -r .id <<<"$app")" >&2
  fi
fi
if ! jq -e --arg d "$HOST/healthz" '.result[] | select(.domain == $d)' <<<"$apps" >/dev/null; then
  body="$(jq -n --arg d "$HOST/healthz" '{
    name: "kuakua healthz", type: "self_hosted", domain: $d, app_launcher_visible: false,
    policies: [{name: "public healthz", decision: "bypass", include: [{everyone: {}}]}]
  }')"
  cf POST "$ACCT/access/apps" "$body" >/dev/null && echo "access: created /healthz bypass" >&2
fi

# DNS: a Custom Domain needs the hostname free of other records.
zone=""
candidate="$HOST"
while [[ "$candidate" == *.* && -z "$zone" ]]; do
  zone="$(cf GET "$API/zones?name=$candidate&account.id=$CLOUDFLARE_ACCOUNT_ID" | jq -r '.result[0].id // empty')"
  candidate="${candidate#*.}"
done
[[ -n "$zone" ]] || { echo "No zone in this account covers $HOST" >&2; exit 1; }
domains="$(curl -sS "$ACCT/workers/domains?hostname=$HOST" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")"
if [[ "$(jq -r .success <<<"$domains")" != "true" ]]; then
  echo "workers: can't read Custom Domains ($(jq -c '[.errors[]?.message]' <<<"$domains")) — the token needs Account › Workers Scripts: Edit to deploy" >&2
fi
ours="$(jq -r --arg s "$NAME" '[.result[]? | select(.service == $s)] | length' <<<"$domains")"
if [[ "$ours" == "0" ]]; then
  records="$(cf GET "$API/zones/$zone/dns_records?name=$HOST" | jq -c '[.result[] | {id, type, content}]')"
  if [[ "$(jq length <<<"$records")" -gt 0 ]]; then
    if [[ "$REPLACE_DNS" == 1 ]]; then
      for id in $(jq -r '.[].id' <<<"$records"); do cf DELETE "$API/zones/$zone/dns_records/$id" >/dev/null; done
      echo "dns: deleted $(jq -c 'map("\(.type) \(.content)")' <<<"$records") for $HOST — run scripts/deploy.sh now" >&2
    else
      echo "dns: $HOST still has $(jq -c 'map("\(.type) \(.content)")' <<<"$records"); the Worker can't take it until that's" >&2
      echo "     removed. When you're ready to switch, re-run with --replace-dns, then scripts/deploy.sh." >&2
    fi
  fi
fi

# 6. App settings
bun scripts/config.ts set CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN" >&2
bun scripts/config.ts set CF_ACCESS_AUD "$(jq -r .aud <<<"$app")" >&2
bun scripts/config.ts set D1_DATABASE_ID "$DB_ID" >&2
echo "done: next, scripts/deploy.sh" >&2
