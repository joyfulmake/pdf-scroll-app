// Cloudflare Pages Function — GET /api/auth/me: reports the current session, if any.
// The frontend feature-detects/gates off this endpoint's status code.
import { requireAuth, authUserPublicShape } from "../../../src/authHandlers.js";

export async function onRequestGet({ request, env }) {
  const user = await requireAuth(request, env);
  if (!user) return Response.json({ authenticated: false }, { status: 401 });
  return Response.json({ authenticated: true, user: authUserPublicShape(user) });
}
