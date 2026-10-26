#!/usr/bin/env bash
# Idempotently prepares the Cloudflare account for this deployment (PUBLIC_URL):
#   1. checks the Zero Trust organization (its team domain is the sign-in page)
#   2. D1 database <WORKER_NAME>            (created in DATA_LOCATION if missing)
#   3. R2 bucket <WORKER_NAME>-files        (avatars and the uploaded roster)
#   4. an Access policy "kuakua: <hostname>" allowing ADMIN_EMAILS, ALLOWED_EMAIL_DOMAINS and,
#      for DIRECTORY_SOURCE=roster, everyone in the roster (re-run after changing any of those)
#   5. the Access app for <hostname> (created with that policy);
#      an existing app that uses other policies is left as it is
#   6. writes CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and D1_DATABASE_ID into .env.production
# The Worker and its Custom Domain are created by scripts/deploy.sh. This script reports
# conflicting DNS records so they can be resolved before deployment.
#
# With EMAIL_NOTIFY=1 it also checks that EMAIL_FROM's domain is onboarded to Cloudflare Email
# Sending, and onboards it with --enable-email (that adds DNS records; see below).
#
# Settings come from .env.production; credentials from the file named by CLOUDFLARE_ENV_FILE
# (default .env.cloudflare, never committed): CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
# Token permissions: see AGENTS.md.
set -euo pipefail
export DO_NOT_TRACK=1 CF_SEND_TELEMETRY=false WRANGLER_SEND_METRICS=false
cd "$(dirname "$0")/.."

ENABLE_EMAIL=0
for arg in "$@"; do
  case "$arg" in
    --enable-email) ENABLE_EMAIL=1 ;;
    *) echo "unknown option $arg (expected --enable-email)" >&2; exit 1 ;;
  esac
done

conf() { node scripts/config.ts get "$1" --raw; }
for tool in curl jq node pnpm; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done

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

# Account-scoped Access commands must not inherit a zone selector from the shell.
unset CLOUDFLARE_ZONE_ID

# 1. Zero Trust organization
TEAM_DOMAIN="$(pnpm exec cf zero-trust organization get | jq -r '.auth_domain // empty')" || true
if [[ -z "$TEAM_DOMAIN" ]]; then
  echo "This account has no Cloudflare Zero Trust organization yet. Open the Zero Trust dashboard once," >&2
  echo "pick a team name, and add a login method (Settings → Authentication; One-time PIN works), then re-run." >&2
  exit 1
fi
echo "access: team domain $TEAM_DOMAIN" >&2

# 2. D1
DB_ID="$(pnpm exec cf d1 list --name "$NAME" | jq -r --arg n "$NAME" '[.[] | select(.name == $n)][0].uuid // empty')"
if [[ -z "$DB_ID" ]]; then
  body="$(jq -n --arg n "$NAME" --arg l "$LOCATION" '{name: $n} + (if $l == "" then {} else {primary_location_hint: $l} end)')"
  DB_ID="$(pnpm exec cf d1 create --body "$body" | jq -r .uuid)"
  echo "d1: created $NAME ($DB_ID)${LOCATION:+ in $LOCATION}" >&2
else
  echo "d1: $NAME exists ($DB_ID)" >&2
fi

# 3. R2
if pnpm exec cf r2 buckets list --name-contains "$BUCKET" | jq -e --arg b "$BUCKET" '.buckets[] | select(.name == $b)' >/dev/null; then
  echo "r2: $BUCKET exists" >&2
else
  body="$(jq -n --arg n "$BUCKET" --arg l "$LOCATION" '{name: $n} + (if $l == "" then {} else {locationHint: $l} end)')"
  pnpm exec cf r2 buckets create --body "$body" >/dev/null
  echo "r2: created $BUCKET${LOCATION:+ in $LOCATION}" >&2
fi

# 4 + 5. Access app for the hostname, guarded by a policy this script manages. An app that
# already exists with policies managed outside this script is left alone.
apps="$(pnpm exec cf zero-trust access applications list --domain "$HOST" --per-page 500)"
app="$(jq -c --arg d "$HOST" '[.[] | select(.domain == $d)][0] // empty' <<<"$apps")"
policy_id="$(pnpm exec cf zero-trust access policies list --per-page 500 | jq -r --arg n "$POLICY_NAME" '[.[] | select(.name == $n)][0].id // empty')"
if [[ -n "$app" ]] && ! jq -e --arg pid "$policy_id" '$pid != "" and (.policies // [] | map(.id) | index($pid))' <<<"$app" >/dev/null; then
  echo "access: app for $HOST exists ($(jq -r .id <<<"$app")) with its own policies ($(jq -r '[.policies[]?.name] | join(", ")' <<<"$app")); leaving them as they are" >&2
else
  include="$(node scripts/config.ts access-include)"
  [[ "$(jq length <<<"$include")" -gt 0 ]] || { echo "Nobody would be allowed in: set ADMIN_EMAILS / ALLOWED_EMAIL_DOMAINS / a roster" >&2; exit 1; }
  policy_body="$(jq -n --arg n "$POLICY_NAME" --argjson inc "$include" '{name: $n, decision: "allow", include: $inc, session_duration: "24h"}')"
  if [[ -n "$policy_id" ]]; then
    pnpm exec cf zero-trust access policies update "$policy_id" --body "$policy_body" >/dev/null
    echo "access: updated policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
  else
    policy_id="$(pnpm exec cf zero-trust access policies create --body "$policy_body" | jq -r .id)"
    echo "access: created policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
  fi
  if [[ -z "$app" ]]; then
    idps="$(pnpm exec cf zero-trust identity-providers list | jq -c '[.[].id]')"
    [[ "$idps" != "[]" ]] || echo "access: warning — no login methods configured; add One-time PIN in Zero Trust → Settings → Authentication" >&2
    body="$(jq -n --arg name "$APP_NAME" --arg d "$HOST" --argjson idps "$idps" --arg pid "$policy_id" '{
      name: $name, type: "self_hosted", domain: $d, session_duration: "24h",
      app_launcher_visible: true, allowed_idps: $idps, auto_redirect_to_identity: false,
      policies: [{id: $pid, precedence: 1}]
    }')"
    app="$(pnpm exec cf zero-trust access applications create --body "$body")"
    echo "access: created app $(jq -r .id <<<"$app")" >&2
  else
    echo "access: app for $HOST exists $(jq -r .id <<<"$app")" >&2
  fi
fi

# DNS: a Custom Domain needs the hostname free of other records.
find_zone() {
  local candidate="$1" found=""
  while [[ "$candidate" == *.* && -z "$found" ]]; do
    found="$(pnpm exec cf zones list --name "$candidate" --account-id "$CLOUDFLARE_ACCOUNT_ID" | jq -r '.[0].id // empty')"
    candidate="${candidate#*.}"
  done
  printf '%s' "$found"
}
zone="$(find_zone "$HOST")"
[[ -n "$zone" ]] || { echo "No zone in this account covers $HOST" >&2; exit 1; }
# Explicitly retained with user approval: cf beta.23 has no Custom Domain query.
# This existing read-only check is the sole direct Cloudflare API call.
domains="$(curl -sS "$ACCT/workers/domains?hostname=$HOST" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")"
if [[ "$(jq -r .success <<<"$domains")" != "true" ]]; then
  echo "workers: can't read Custom Domains ($(jq -c '[.errors[]?.message]' <<<"$domains")) — the token needs Account › Workers Scripts: Edit to deploy" >&2
fi
ours="$(jq -r --arg s "$NAME" '[.result[]? | select(.service == $s)] | length' <<<"$domains")"
if [[ "$ours" == "0" ]]; then
  records="$(pnpm exec cf dns records list --zone "$zone" --name "$HOST" | jq -c '[.[] | {id, type, content}]')"
  if [[ "$(jq length <<<"$records")" -gt 0 ]]; then
    echo "dns: $HOST has conflicting records: $(jq -c 'map("\(.type) \(.content)")' <<<"$records")" >&2
    echo "     Resolve them in Cloudflare DNS, then re-run scripts/cloudflare-setup.sh." >&2
    exit 1
  fi
fi

# Email: EMAIL_FROM's domain must be onboarded to Cloudflare Email Sending. That adds DNS records
# (MX + SPF on cf-bounce.<domain>, DKIM at cf-bounce._domainkey.<domain>, DMARC at _dmarc.<domain>),
# so it only happens with --enable-email.
if [[ "$(conf EMAIL_NOTIFY)" == "1" ]]; then
  MAIL_FROM="$(conf EMAIL_FROM)"
  MAIL_DOMAIN="${MAIL_FROM#*@}"
  mail_zone="$(find_zone "$MAIL_DOMAIN")"
  [[ -n "$mail_zone" ]] || { echo "No zone in this account covers $MAIL_DOMAIN" >&2; exit 1; }
  if listing="$(pnpm exec cf email-sending subdomains list --zone "$mail_zone")"; then
    subdomain_id="$(jq -r --arg domain "$MAIL_DOMAIN" '[.[] | select(.name == $domain)][0].id // empty' <<<"$listing")"
    if [[ -n "$subdomain_id" ]]; then
      echo "email: $MAIL_DOMAIN is onboarded to Email Sending" >&2
    elif [[ "$ENABLE_EMAIL" == 1 ]]; then
      subdomain_id="$(pnpm exec cf email-sending subdomains create --zone "$mail_zone" --name "$MAIL_DOMAIN" | jq -r .id)"
      echo "email: onboarded $MAIL_DOMAIN; DNS records:" >&2
      pnpm exec cf email-sending subdomains dns get "$subdomain_id" --zone "$mail_zone" >&2
    else
      echo "email: $MAIL_DOMAIN isn't onboarded. Re-run with --enable-email to add Email Sending DNS records," >&2
      echo "       or use Dashboard → Email Service → Email Sending → Onboard Domain." >&2
    fi
  else
    echo "email: can't list sending domains with this token; check Email Sending permissions in the dashboard." >&2
  fi
fi

# 6. App settings
node scripts/config.ts set CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN" >&2
node scripts/config.ts set CF_ACCESS_AUD "$(jq -r .aud <<<"$app")" >&2
node scripts/config.ts set D1_DATABASE_ID "$DB_ID" >&2
echo "done: next, scripts/deploy.sh" >&2
