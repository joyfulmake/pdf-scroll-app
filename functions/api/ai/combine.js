// Cloudflare Pages Functions entry point — mirrors src/worker.js's /api/ai/combine
// route for the pages.dev deployment target, sharing the same handler logic.
import { combine } from "../../../src/aiHandlers.js";
import { requireAuth } from "../../../src/authHandlers.js";

export async function onRequestPost({ request, env }) {
  const user = await requireAuth(request, env);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
  try {
    const text = await combine(env, await request.json());
    return Response.json({ text }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return Response.json({ error: err.message || "AI request failed." }, { status: 500 });
  }
}
