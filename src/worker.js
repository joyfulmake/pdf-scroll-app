// Serves the static app for everything except /api/ai/*, which proxies to Cloudflare
// Workers AI (bound directly to this Worker — no API key needed, free tier). This
// keeps AI credentials entirely server-side: the browser never sees or needs one.

import { explain, summarize, combine } from "./aiHandlers.js";

function json(data, init) {
  return Response.json(data, {
    ...init,
    headers: { "Access-Control-Allow-Origin": "*", ...(init?.headers || {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type",
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/ai/explain") {
        const text = await explain(env, await request.json());
        return json({ text });
      }
      if (request.method === "POST" && url.pathname === "/api/ai/summarize") {
        const text = await summarize(env, await request.json());
        return json({ text });
      }
      if (request.method === "POST" && url.pathname === "/api/ai/combine") {
        const text = await combine(env, await request.json());
        return json({ text });
      }
    } catch (err) {
      return json({ error: err.message || "AI request failed." }, { status: 500 });
    }

    return env.ASSETS.fetch(request);
  },
};
