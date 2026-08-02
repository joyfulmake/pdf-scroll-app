// Cloudflare Pages Functions entry point — mirrors src/worker.js's /api/ai/combine
// route for the pages.dev deployment target, sharing the same handler logic.
import { combine } from "../../../src/aiHandlers.js";

export async function onRequestPost({ request, env }) {
  try {
    const text = await combine(env, await request.json());
    return Response.json({ text }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return Response.json({ error: err.message || "AI request failed." }, { status: 500 });
  }
}
