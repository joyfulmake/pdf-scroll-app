// Cloudflare Pages Function — GET /api/auth/google/start: kicks off the Google OAuth
// flow by redirecting to Google's consent screen, with a short-lived state cookie to
// guard the callback against CSRF.
import { buildGoogleAuthUrl } from "../../../../src/authHandlers.js";
import { randomToken, stateCookieHeader } from "../../../../src/authCookies.js";

export async function onRequestGet({ request, env }) {
  if (!env.GOOGLE_CLIENT_ID) {
    return Response.json({ error: "Sign-in is not configured on this deployment (missing GOOGLE_CLIENT_ID)." }, { status: 500 });
  }
  const url = new URL(request.url);
  const state = randomToken(24);
  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const authUrl = buildGoogleAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state });
  return new Response(null, {
    status: 302,
    headers: { Location: authUrl, "Set-Cookie": stateCookieHeader(state) },
  });
}
