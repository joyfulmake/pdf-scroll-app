// Cloudflare Pages Functions entry point — mirrors src/worker.js's /api/ai/summarize
// route for the pages.dev deployment target, sharing the same handler logic.
import { summarize } from "../../../src/aiHandlers.js";

export async function onRequestPost({ request, env }) {
  try {
    const text = await summarize(env, await request.json());
    return Response.json({ text }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return Response.json({ error: err.message || "AI request failed." }, { status: 500 });
  }
}
