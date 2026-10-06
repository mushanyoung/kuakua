import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config";
import { canSignIn, HttpError } from "./store";

const { teamDomain, aud, devEmail } = config.access;
const jwks = teamDomain ? createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)) : null;

if (config.production && (!teamDomain || !aud)) {
  throw new Error("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required in production");
}
if (config.production && devEmail) {
  throw new Error("DEV_AUTH_EMAIL must not be set in production");
}

function readCookie(req: Request, name: string) {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Returns the Cloudflare Access-verified company email of the caller.
export async function authenticate(req: Request): Promise<string> {
  const token = req.headers.get("cf-access-jwt-assertion") ?? readCookie(req, "CF_Authorization");
  let email: string | undefined;
  if (token && jwks) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${teamDomain}`, audience: aud });
      email = typeof payload.email === "string" ? payload.email : undefined;
    } catch {
      throw new HttpError(401, "invalid_access_token");
    }
  } else if (devEmail) {
    email = devEmail;
  }
  if (!email) throw new HttpError(401, "unauthenticated");
  email = email.toLowerCase();
  if (!canSignIn(email)) throw new HttpError(403, "email_domain_not_allowed");
  return email;
}
