#!/usr/bin/env bash
# Idempotently puts this deployment (PUBLIC_URL) behind Cloudflare on this machine:
#   1. a Cloudflare Tunnel: CLOUDFLARE_TUNNEL_ID, or one named after SERVICE_NAME (found or created).
#      If no connector is running for it, writes local/cloudflared-token and prints the install command.
#   2. proxied CNAME <hostname> -> <tunnel>.cfargotunnel.com
#   3. tunnel ingress <hostname> -> http://127.0.0.1:<PORT> (other hostnames' rules are kept)
#   4. an Access policy "kuakua: <hostname>" allowing ADMIN_EMAILS, ALLOWED_EMAIL_DOMAINS and,
#      for DIRECTORY_SOURCE=roster, everyone in the roster (re-run after changing any of those)
#   5. the Access app for <hostname> (created with that policy) and a public bypass for /healthz
#   6. writes CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD into .env.production
#
# Settings come from .env.production; credentials from the file named by CLOUDFLARE_ENV_FILE
# (default .env.cloudflare, never committed):
#   CLOUDFLARE_API_TOKEN   token with Account › Cloudflare Tunnel: Edit, Account › Access: Apps and
#                          Policies: Edit, Account › Access: Organizations, Identity Providers, and
#                          Groups: Read, Zone › DNS: Edit (for the hostname's zone)
#   CLOUDFLARE_ACCOUNT_ID
#   CLOUDFLARE_ZONE_ID     optional; looked up from the hostname
#   CLOUDFLARE_TUNNEL_ID   optional; see step 1 (saved back to the file once known)
set -euo pipefail
cd "$(dirname "$0")/.."

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
ORIGIN="http://127.0.0.1:$(conf PORT)"
SERVICE="$(conf SERVICE_NAME)"
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

remember() { # remember KEY VALUE in the credentials file
  [[ -f "$CF_FILE" ]] || install -m 600 /dev/null "$CF_FILE"
  if grep -q "^$1=" "$CF_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$CF_FILE"; else echo "$1=$2" >>"$CF_FILE"; fi
}

# 0. Zero Trust organization (team domain)
TEAM_DOMAIN="$(cf GET "$ACCT/access/organizations" | jq -r '.result.auth_domain // empty')" || true
if [[ -z "$TEAM_DOMAIN" ]]; then
  echo "This account has no Cloudflare Zero Trust organization yet. Open the Zero Trust dashboard once," >&2
  echo "pick a team name, and add a login method (Settings → Authentication; One-time PIN works), then re-run." >&2
  exit 1
fi

# 1. Tunnel
if [[ -z "${CLOUDFLARE_TUNNEL_ID:-}" ]]; then
  CLOUDFLARE_TUNNEL_ID="$(cf GET "$ACCT/cfd_tunnel?name=$SERVICE&is_deleted=false" | jq -r '.result[0].id // empty')"
  if [[ -z "$CLOUDFLARE_TUNNEL_ID" ]]; then
    body="$(jq -n --arg n "$SERVICE" '{name: $n, config_src: "cloudflare"}')"
    CLOUDFLARE_TUNNEL_ID="$(cf POST "$ACCT/cfd_tunnel" "$body" | jq -r .result.id)"
    echo "tunnel: created $SERVICE ($CLOUDFLARE_TUNNEL_ID)" >&2
  fi
  remember CLOUDFLARE_TUNNEL_ID "$CLOUDFLARE_TUNNEL_ID"
fi
connections="$(cf GET "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID" | jq '.result.connections | length')"
if [[ "$connections" == "0" ]]; then
  mkdir -p local
  cf GET "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID/token" | jq -r .result >local/cloudflared-token
  chmod 600 local/cloudflared-token
  echo "tunnel: no connector is running. On this machine run:" >&2
  echo "    sudo cloudflared service install \"\$(cat local/cloudflared-token)\"" >&2
else
  echo "tunnel: $CLOUDFLARE_TUNNEL_ID has $connections connection(s)" >&2
fi

# 2. DNS
if [[ -z "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  candidate="$HOST"
  while [[ "$candidate" == *.* && -z "${CLOUDFLARE_ZONE_ID:-}" ]]; do
    CLOUDFLARE_ZONE_ID="$(cf GET "$API/zones?name=$candidate&account.id=$CLOUDFLARE_ACCOUNT_ID" | jq -r '.result[0].id // empty')"
    candidate="${candidate#*.}"
  done
  [[ -n "$CLOUDFLARE_ZONE_ID" ]] || { echo "No zone in this account covers $HOST" >&2; exit 1; }
  remember CLOUDFLARE_ZONE_ID "$CLOUDFLARE_ZONE_ID"
fi
target="$CLOUDFLARE_TUNNEL_ID.cfargotunnel.com"
record="$(jq -n --arg n "$HOST" --arg c "$target" '{type: "CNAME", name: $n, content: $c, proxied: true, ttl: 1, comment: "kuakua via tunnel"}')"
existing="$(cf GET "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=CNAME&name=$HOST" | jq -r '.result[0].id // empty')"
if [[ -n "$existing" ]]; then
  cf PUT "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$existing" "$record" >/dev/null && echo "dns: updated $HOST -> $target" >&2
else
  cf POST "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records" "$record" >/dev/null && echo "dns: created $HOST -> $target" >&2
fi

# 3. Tunnel ingress: replace any rule for this hostname, keep everything else, keep the catch-all last.
current="$(cf GET "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID/configurations")"
payload="$(jq --arg h "$HOST" --arg s "$ORIGIN" '
  (.result.config // {}) as $c
  | ($c.ingress // [] | map(select(.hostname != $h))) as $rest
  | {config: ($c | .ingress = (
      ($rest | map(select(.hostname != null)))
      + [{hostname: $h, service: $s, originRequest: {}}]
      + (($rest | map(select(.hostname == null))) | if length == 0 then [{service: "http_status:404"}] else . end)
    ))}' <<<"$current")"
cf PUT "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID/configurations" "$payload" >/dev/null
echo "tunnel: $HOST -> $ORIGIN" >&2

# 4. Access policy managed by this script
include="$(bun scripts/config.ts access-include)"
[[ "$(jq length <<<"$include")" -gt 0 ]] || { echo "Nobody would be allowed in: set ADMIN_EMAILS / ALLOWED_EMAIL_DOMAINS / a roster" >&2; exit 1; }
policy_body="$(jq -n --arg n "$POLICY_NAME" --argjson inc "$include" '{name: $n, decision: "allow", include: $inc, session_duration: "24h"}')"
policy_id="$(cf GET "$ACCT/access/policies?per_page=500" | jq -r --arg n "$POLICY_NAME" '[.result[] | select(.name == $n)][0].id // empty')"
if [[ -n "$policy_id" ]]; then
  cf PUT "$ACCT/access/policies/$policy_id" "$policy_body" >/dev/null
  echo "access: updated policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
else
  policy_id="$(cf POST "$ACCT/access/policies" "$policy_body" | jq -r .result.id)"
  echo "access: created policy \"$POLICY_NAME\" ($(jq length <<<"$include") rules)" >&2
fi

# 5. Access app + public /healthz
apps="$(cf GET "$ACCT/access/apps?per_page=500")"
app="$(jq -c --arg d "$HOST" '[.result[] | select(.domain == $d)][0] // empty' <<<"$apps")"
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
  echo "access: app already exists $(jq -r .id <<<"$app")" >&2
  if ! jq -e --arg pid "$policy_id" '.policies // [] | map(.id) | index($pid)' <<<"$app" >/dev/null; then
    echo "access: note — that app doesn't use \"$POLICY_NAME\"; its own policies decide who gets in." >&2
  fi
fi
if ! jq -e --arg d "$HOST/healthz" '.result[] | select(.domain == $d)' <<<"$apps" >/dev/null; then
  body="$(jq -n --arg d "$HOST/healthz" '{
    name: "kuakua healthz", type: "self_hosted", domain: $d, app_launcher_visible: false,
    policies: [{name: "public healthz", decision: "bypass", include: [{everyone: {}}]}]
  }')"
  cf POST "$ACCT/access/apps" "$body" >/dev/null && echo "access: created /healthz bypass" >&2
fi

# 6. App settings
bun scripts/config.ts set CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN" >&2
bun scripts/config.ts set CF_ACCESS_AUD "$(jq -r .aud <<<"$app")" >&2
echo "done: https://$HOST is served by tunnel $CLOUDFLARE_TUNNEL_ID; run scripts/deploy.sh to (re)start the app." >&2
