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

// Returns a raw two-line "THEME: x\nPACE: y" string — parsed leniently on the client
// (js/aiClient.js) rather than here, so a slightly-off model response never throws or
// breaks the export flow; it just falls back to a default theme/pace client-side.
export async function suggestTheme(env, { text, title }) {
  if (!text?.trim()) throw new Error("Nothing to analyze.");
  const prompt = `You're picking a visual theme and pacing for a short scrolling video reading of a document${title ? ` ("${title}")` : ""}. Available themes: classic (calm purple), midnight (dark, minimal, serious), sunrise (warm, energetic, upbeat), mono (grayscale, corporate/formal), cyberpunk (neon, high-energy, bold). Available paces: slow, medium, fast.\n\nBased on this document's actual content and tone, respond with EXACTLY two lines and nothing else — no explanation:\nTHEME: <one of classic, midnight, sunrise, mono, cyberpunk>\nPACE: <one of slow, medium, fast>\n\nDocument:\n"""${clip(text)}"""`;
  return runModel(env, prompt, 20);
}

export async function quiz(env, { text, title }) {
  if (!text?.trim()) throw new Error("Nothing to quiz on.");
  const prompt = `Write 5 short quiz questions (with answers) testing understanding of the key points in this document${title ? ` ("${title}")` : ""}. Format each pair exactly as:\nQ: <question>\nA: <answer>\nwith a blank line between pairs. No intro, no numbering, no other commentary.\n\n"""${clip(text)}"""`;
  return runModel(env, prompt, 700);
}

// Asks for sentences copied VERBATIM (not paraphrased) — the client matches these
// back to the document's own rendered segments by substring, so wording has to
// actually match the source or the highlight reel can't find where to crop from.
export async function pickHighlights(env, { text, title }) {
  if (!text?.trim()) throw new Error("Nothing to pick highlights from.");
  const prompt = `Pick the 4 to 6 most important or interesting sentences from this document${title ? ` ("${title}")` : ""} — the ones that would make the best short highlight reel. Copy each sentence EXACTLY as written in the source, word for word, do not paraphrase or shorten it. One sentence per line, no numbering, no commentary, nothing else.\n\n"""${clip(text)}"""`;
  return runModel(env, prompt, 400);
}
