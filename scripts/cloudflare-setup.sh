#!/usr/bin/env bash
# Idempotently wires kuakua.maxinsights.ai to this machine:
#   1. proxied CNAME  <hostname> -> <tunnel>.cfargotunnel.com
#   2. tunnel ingress <hostname> -> $ORIGIN   (other ingress rules are preserved)
#   3. Access app for <hostname>, allowing only company emails
#   4. Access bypass for <hostname>/healthz (uptime checks; returns "ok" only)
# Prints the Access AUD tag for CF_ACCESS_AUD.
#
# Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_TUNNEL_ID,
# either exported or in the file named by CLOUDFLARE_ENV_FILE.
set -euo pipefail

if [[ -n "${CLOUDFLARE_ENV_FILE:-}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CLOUDFLARE_ENV_FILE"
  set +a
fi
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_ZONE_ID:?}" "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_TUNNEL_ID:?}"

HOST="${KUAKUA_HOSTNAME:-kuakua.maxinsights.ai}"
ORIGIN="${ORIGIN:-http://127.0.0.1:4380}"
EMAIL_DOMAIN="${EMAIL_DOMAIN:-maxinsights.ai}"
APP_NAME="${APP_NAME:-夸夸 Kuakua}"
API="https://api.cloudflare.com/client/v4"
ACCT="$API/accounts/$CLOUDFLARE_ACCOUNT_ID"

cf() {
  local method="$1" url="$2" data="${3:-}" out
  out="$(curl -sS -X "$method" "$url" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" ${data:+--data "$data"})"
  if [[ "$(jq -r .success <<<"$out")" != "true" ]]; then
    echo "Cloudflare API $method $url failed: $(jq -c .errors <<<"$out")" >&2
    exit 1
  fi
  echo "$out"
}

# 1. DNS
target="$CLOUDFLARE_TUNNEL_ID.cfargotunnel.com"
record="$(jq -n --arg n "$HOST" --arg c "$target" '{type: "CNAME", name: $n, content: $c, proxied: true, ttl: 1, comment: "kuakua via tunnel"}')"
existing="$(cf GET "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=CNAME&name=$HOST" | jq -r '.result[0].id // empty')"
if [[ -n "$existing" ]]; then
  cf PUT "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$existing" "$record" >/dev/null && echo "dns: updated $HOST -> $target" >&2
else
  cf POST "$API/zones/$CLOUDFLARE_ZONE_ID/dns_records" "$record" >/dev/null && echo "dns: created $HOST -> $target" >&2
fi

# 2. Tunnel ingress: replace any rule for this hostname, keep everything else, keep the catch-all last.
current="$(cf GET "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID/configurations")"
payload="$(jq --arg h "$HOST" --arg s "$ORIGIN" '
  .result.config as $c
  | ($c.ingress // [] | map(select(.hostname != $h))) as $rest
  | {config: ($c | .ingress = (
      ($rest | map(select(.hostname != null)))
      + [{hostname: $h, service: $s, originRequest: {}}]
      + ($rest | map(select(.hostname == null)))
    ))}' <<<"$current")"
cf PUT "$ACCT/cfd_tunnel/$CLOUDFLARE_TUNNEL_ID/configurations" "$payload" >/dev/null
echo "tunnel: $HOST -> $ORIGIN" >&2

# 3. Access app (company email only)
apps="$(cf GET "$ACCT/access/apps?per_page=500")"
app="$(jq -c --arg d "$HOST" '[.result[] | select(.domain == $d)][0] // empty' <<<"$apps")"
if [[ -z "$app" ]]; then
  policy="$(cf GET "$ACCT/access/policies?per_page=200" | jq -r --arg d "$EMAIL_DOMAIN" '
    [.result[] | select(.decision == "allow" and .include == [{email_domain: {domain: $d}}] and (.exclude // []) == [] and (.require // []) == [])]
    | sort_by(-.app_count) | .[0].id // empty')"
  idps="$(cf GET "$ACCT/access/identity_providers" | jq -c '[.result[] | select(.type == "google-apps" or .type == "onetimepin") | .id]')"
  if [[ -n "$policy" ]]; then
    policies="$(jq -n --arg id "$policy" '[{id: $id, precedence: 1}]')"
  else
    policies="$(jq -n --arg d "$EMAIL_DOMAIN" '[{name: "Company email", decision: "allow", include: [{email_domain: {domain: $d}}]}]')"
  fi
  body="$(jq -n --arg name "$APP_NAME" --arg d "$HOST" --argjson idps "$idps" --argjson policies "$policies" '{
    name: $name, type: "self_hosted", domain: $d, session_duration: "24h",
    app_launcher_visible: true, allowed_idps: $idps, auto_redirect_to_identity: false,
    policies: $policies
  }')"
  app="$(cf POST "$ACCT/access/apps" "$body" | jq -c .result)"
  echo "access: created app $(jq -r .id <<<"$app")" >&2
else
  echo "access: app already exists $(jq -r .id <<<"$app")" >&2
fi

# 4. Public health check
if ! jq -e --arg d "$HOST/healthz" '.result[] | select(.domain == $d)' <<<"$apps" >/dev/null; then
  body="$(jq -n --arg d "$HOST/healthz" '{
    name: "kuakua healthz", type: "self_hosted", domain: $d, app_launcher_visible: false,
    policies: [{name: "public healthz", decision: "bypass", include: [{everyone: {}}]}]
  }')"
  cf POST "$ACCT/access/apps" "$body" >/dev/null && echo "access: created /healthz bypass" >&2
fi

jq -r .aud <<<"$app"
