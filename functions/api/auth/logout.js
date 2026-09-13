// Cloudflare Pages Function — POST /api/auth/logout: ends the current session.
import { deleteSession } from "../../../src/authHandlers.js";
import { getSessionToken, clearSessionCookieHeader } from "../../../src/authCookies.js";

export async function onRequestPost({ request, env }) {
  const token = getSessionToken(request);
  if (token) await deleteSession(env, token);
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookieHeader() } });
}
