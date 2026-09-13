// Shared Google OAuth + D1-backed session logic, used by functions/api/auth/*.js
// (the endpoints themselves) and functions/api/ai/*.js (via requireAuth, gating the
// only endpoints that do real work) — same "one shared module, thin per-endpoint
// wrappers" shape as src/aiHandlers.js.

import { sha256Hex, randomToken, getSessionToken } from "./authCookies.js";

const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days — a passive reading app shouldn't force frequent re-logins
const UPGRADE_BANNER_AFTER_MS = 90 * 24 * 60 * 60 * 1000; // nudge once a free account is 90 days past signup

export function buildGoogleAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchanges the authorization code for tokens, then verifies the id_token via
// Google's own tokeninfo endpoint (which validates the signature server-side and
// hands back verified claims) rather than implementing JWK-based JWT verification
// by hand — keeps this dependency-free in the Pages Functions runtime.
export async function exchangeGoogleCode({ code, clientId, clientSecret, redirectUri }) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed: HTTP ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 300)}`);
  const tokenJson = await tokenRes.json();
  if (!tokenJson.id_token) throw new Error("Google token response had no id_token");

  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenJson.id_token)}`);
  if (!infoRes.ok) throw new Error(`Google tokeninfo verification failed: HTTP ${infoRes.status}`);
  const claims = await infoRes.json();

  if (claims.aud !== clientId) throw new Error("Google id_token audience mismatch");
  if (!claims.sub || !claims.email) throw new Error("Google id_token missing sub/email claim");

  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === "true",
    name: claims.name || claims.email,
  };
}

function shouldShowUpgradeBanner(user) {
  return !user.upgradeBannerDismissedAt && Date.now() - user.createdAt >= UPGRADE_BANNER_AFTER_MS;
}

// Shape returned to the frontend — never the raw D1 row (no google_sub, no columns
// beyond what the UI actually needs). The 90-day math happens here, once, server-side,
// so the frontend never computes it itself and can't drift from the server's clock.
export function authUserPublicShape(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    plan: user.plan,
    createdAt: user.createdAt,
    showUpgradeBanner: shouldShowUpgradeBanner(user),
  };
}

export async function upsertUserFromGoogle(env, identity) {
  const existing = await env.DB
    .prepare(
      `SELECT id, email, display_name AS displayName, plan, created_at AS createdAt, upgrade_banner_dismissed_at AS upgradeBannerDismissedAt
       FROM users WHERE google_sub = ?`
    )
    .bind(identity.sub)
    .first();
  if (existing) return existing;

  const user = {
    id: crypto.randomUUID(),
    email: identity.email,
    displayName: identity.name,
    plan: "free",
    createdAt: Date.now(),
    upgradeBannerDismissedAt: null,
  };
  await env.DB
    .prepare(`INSERT INTO users (id, google_sub, email, display_name, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(user.id, identity.sub, user.email, user.displayName, user.plan, user.createdAt)
    .run();
  return user;
}

export async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await env.DB
    .prepare(`INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, userId, now, expiresAt)
    .run();
  return { token, expiresAt };
}

async function getUserByToken(env, token) {
  const tokenHash = await sha256Hex(token);
  return env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name AS displayName, u.plan, u.created_at AS createdAt, u.upgrade_banner_dismissed_at AS upgradeBannerDismissedAt
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .bind(tokenHash, Date.now())
    .first();
}

export async function deleteSession(env, token) {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function dismissUpgradeBanner(env, userId) {
  await env.DB.prepare(`UPDATE users SET upgrade_banner_dismissed_at = ? WHERE id = ?`).bind(Date.now(), userId).run();
}

// A fixed fake user that never touches Google, D1, or cookies — only reachable when a
// request carries a header matching TEST_AUTH_BYPASS_SECRET. That secret must ONLY
// ever be set in a local `wrangler pages dev` .dev.vars file for smoke-test runs — it
// must never exist among this project's real deployed Pages secrets. If env doesn't
// define it at all (the normal production case), this branch can never be reached
// regardless of what header a request sends.
const TEST_BYPASS_HEADER = "x-test-auth-bypass";
function testBypassUser() {
  return { id: "test-user", email: "test@example.com", displayName: "Test User", plan: "free", createdAt: Date.now(), upgradeBannerDismissedAt: Date.now() };
}

// Resolves the authenticated user for a request, or null if unauthenticated. Called
// explicitly at the top of every gated route — no middleware framework here, same
// manual-dispatch style as this app's existing routing.
export async function requireAuth(request, env) {
  if (env.TEST_AUTH_BYPASS_SECRET && request.headers.get(TEST_BYPASS_HEADER) === env.TEST_AUTH_BYPASS_SECRET) {
    return testBypassUser();
  }
  const token = getSessionToken(request);
  if (!token) return null;
  const user = await getUserByToken(env, token);
  return user || null;
}
