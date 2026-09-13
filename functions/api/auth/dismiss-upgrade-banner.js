// Cloudflare Pages Function — POST /api/auth/dismiss-upgrade-banner: permanently
// dismisses the 90-day upgrade nudge for the signed-in user. Persisted server-side
// (on the user row) rather than in localStorage so it doesn't reappear on another
// device or after logging back in.
import { requireAuth, dismissUpgradeBanner } from "../../../src/authHandlers.js";

export async function onRequestPost({ request, env }) {
  const user = await requireAuth(request, env);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  await dismissUpgradeBanner(env, user.id);
  return Response.json({ ok: true });
}
