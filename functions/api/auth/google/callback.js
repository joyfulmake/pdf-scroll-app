// Cloudflare Pages Function — GET /api/auth/google/callback: validates the OAuth
// state, exchanges the code for a verified identity, upserts the user, and starts a
// session.
import { exchangeGoogleCode, upsertUserFromGoogle, createSession } from "../../../../src/authHandlers.js";
import { getStateCookie, clearStateCookieHeader, sessionCookieHeader } from "../../../../src/authCookies.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = getStateCookie(request);

  if (!code || !state || !cookieState || state !== cookieState) {
    return Response.redirect(`${url.origin}/?auth_error=state_mismatch`, 302);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.json({ error: "Sign-in is not configured on this deployment." }, { status: 500 });
  }

  try {
    const redirectUri = `${url.origin}/api/auth/google/callback`;
    const identity = await exchangeGoogleCode({ code, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri });
    const user = await upsertUserFromGoogle(env, identity);
    const { token, expiresAt } = await createSession(env, user.id);
    const maxAge = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));

    const headers = new Headers({ Location: `${url.origin}/` });
    headers.append("Set-Cookie", sessionCookieHeader(token, maxAge));
    headers.append("Set-Cookie", clearStateCookieHeader());
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(err.message || "sign_in_failed")}`, 302);
  }
}
