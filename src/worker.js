// Serves the static app for everything except /api/ai/*, which proxies to Cloudflare
// Workers AI (bound directly to this Worker — no API key needed, free tier). This
// keeps AI credentials entirely server-side: the browser never sees or needs one.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT_CHARS = 12000;

function json(data, init) {
  return Response.json(data, {
    ...init,
    headers: { "Access-Control-Allow-Origin": "*", ...(init?.headers || {}) },
  });
}

async function runModel(env, prompt, maxTokens) {
  const result = await env.AI.run(MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
  return (result?.response || "").trim();
}

function clip(text) {
  return String(text || "").slice(0, MAX_INPUT_CHARS);
}

async function handleExplain(request, env) {
  const { selectedText, context } = await request.json();
  if (!selectedText?.trim()) return json({ error: "No text selected." }, { status: 400 });

  const prompt = `You're helping a reader understand part of a document they're reading. Here is some surrounding context for reference:\n\n"""${clip(context)}"""\n\nThe reader highlighted this specific passage and wants it explained clearly and concisely:\n\n"""${clip(selectedText)}"""\n\nGive a clear, helpful explanation of the highlighted passage: what it means, any important context, and why it matters. Keep it focused — a few short paragraphs at most.`;

  const text = await runModel(env, prompt, 500);
  return json({ text });
}

async function handleSummarize(request, env) {
  const { text: inputText, title, isChunk, partIndex, partTotal } = await request.json();
  if (!inputText?.trim()) return json({ error: "Nothing to summarize." }, { status: 400 });

  const prompt = isChunk
    ? `This is part ${partIndex} of ${partTotal} of a longer document${title ? ` ("${title}")` : ""}. Summarize the key points made in this part only, in a few bullet points. Don't say "this part" or reference the fact it's a fragment — just state the points.\n\n"""${clip(inputText)}"""`
    : `Summarize the following document${title ? ` ("${title}")` : ""} for someone who wants the key points without reading the whole thing. Use a short overview paragraph followed by bullet points for the main takeaways.\n\n"""${clip(inputText)}"""`;

  const text = await runModel(env, prompt, isChunk ? 350 : 800);
  return json({ text });
}

async function handleCombine(request, env) {
  const { summaries, title } = await request.json();
  if (!Array.isArray(summaries) || !summaries.length) {
    return json({ error: "Nothing to combine." }, { status: 400 });
  }
  const prompt = `Here are bullet-point summaries of consecutive sections of a document${title ? ` ("${title}")` : ""}. Combine them into one cohesive summary for the reader: a short overview paragraph, then the main takeaways as bullet points, removing redundancy between sections.\n\n${summaries.map((s, i) => `Section ${i + 1}:\n${clip(s)}`).join("\n\n")}`;
  const text = await runModel(env, prompt, 900);
  return json({ text });
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
        return await handleExplain(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/ai/summarize") {
        return await handleSummarize(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/ai/combine") {
        return await handleCombine(request, env);
      }
    } catch (err) {
      return json({ error: err.message || "AI request failed." }, { status: 500 });
    }

    return env.ASSETS.fetch(request);
  },
};
