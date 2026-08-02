// Shared logic for the AI proxy, used by both the Workers entry point
// (src/worker.js) and the Cloudflare Pages Functions entry points
// (functions/api/ai/*.js) so the two deployment targets behave identically.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT_CHARS = 12000;

function clip(text) {
  return String(text || "").slice(0, MAX_INPUT_CHARS);
}

async function runModel(env, prompt, maxTokens) {
  const result = await env.AI.run(MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
  return (result?.response || "").trim();
}

export async function explain(env, { selectedText, context }) {
  if (!selectedText?.trim()) throw new Error("No text selected.");
  const prompt = `You're helping a reader understand part of a document they're reading. Here is some surrounding context for reference:\n\n"""${clip(context)}"""\n\nThe reader highlighted this specific passage and wants it explained clearly and concisely:\n\n"""${clip(selectedText)}"""\n\nGive a clear, helpful explanation of the highlighted passage: what it means, any important context, and why it matters. Keep it focused — a few short paragraphs at most.`;
  return runModel(env, prompt, 500);
}

export async function summarize(env, { text, title, isChunk, partIndex, partTotal }) {
  if (!text?.trim()) throw new Error("Nothing to summarize.");
  const prompt = isChunk
    ? `This is part ${partIndex} of ${partTotal} of a longer document${title ? ` ("${title}")` : ""}. Summarize the key points made in this part only, in a few bullet points. Don't say "this part" or reference the fact it's a fragment — just state the points.\n\n"""${clip(text)}"""`
    : `Summarize the following document${title ? ` ("${title}")` : ""} for someone who wants the key points without reading the whole thing. Use a short overview paragraph followed by bullet points for the main takeaways.\n\n"""${clip(text)}"""`;
  return runModel(env, prompt, isChunk ? 350 : 800);
}

export async function combine(env, { summaries, title }) {
  if (!Array.isArray(summaries) || !summaries.length) throw new Error("Nothing to combine.");
  const prompt = `Here are bullet-point summaries of consecutive sections of a document${title ? ` ("${title}")` : ""}. Combine them into one cohesive summary for the reader: a short overview paragraph, then the main takeaways as bullet points, removing redundancy between sections.\n\n${summaries.map((s, i) => `Section ${i + 1}:\n${clip(s)}`).join("\n\n")}`;
  return runModel(env, prompt, 900);
}
