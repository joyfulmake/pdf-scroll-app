// Calls the Anthropic API directly from the browser using the user's own API key.
// The key lives only in memory for this tab/session (see settings.js) — it is sent
// solely to api.anthropic.com, never anywhere else, and never touches disk.

const API_URL = "https://api.anthropic.com/v1/messages";
const CHUNK_CHARS = 6000;

class AiError extends Error {}

async function callClaude(apiKey, model, prompt, maxTokens = 1024) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    throw new AiError("Couldn't reach Anthropic's API — check your internet connection.");
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    if (res.status === 401) throw new AiError("That API key was rejected. Check it in Settings.");
    throw new AiError(`AI request failed (${res.status}). ${detail}`);
  }

  const data = await res.json();
  return data.content?.map((c) => c.text || "").join("") || "";
}

export async function explainSelection(apiKey, model, selectedText, surroundingContext) {
  const prompt = `You're helping a reader understand part of a document they're reading. Here is some surrounding context for reference:\n\n"""${surroundingContext.slice(0, 3000)}"""\n\nThe reader highlighted this specific passage and wants it explained clearly and concisely:\n\n"""${selectedText}"""\n\nGive a clear, helpful explanation of the highlighted passage: what it means, any important context, and why it matters. Keep it focused — a few short paragraphs at most.`;
  return callClaude(apiKey, model, prompt, 800);
}

function chunkText(text) {
  const paras = text.split(/\n{2,}|\.\s+(?=[A-Z])/);
  const chunks = [];
  let current = "";
  for (const p of paras) {
    if ((current + p).length > CHUNK_CHARS && current) {
      chunks.push(current);
      current = "";
    }
    current += (current ? " " : "") + p;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function summarizeText(apiKey, model, fullText, { title, onProgress } = {}) {
  const chunks = chunkText(fullText);

  if (chunks.length <= 1) {
    onProgress?.(1, 1);
    const prompt = `Summarize the following document${title ? ` ("${title}")` : ""} for someone who wants the key points without reading the whole thing. Use a short overview paragraph followed by bullet points for the main takeaways.\n\n"""${fullText}"""`;
    return callClaude(apiKey, model, prompt, 1000);
  }

  const partial = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i + 1, chunks.length + 1);
    const prompt = `This is part ${i + 1} of ${chunks.length} of a longer document${title ? ` ("${title}")` : ""}. Summarize the key points made in this part only, in a few bullet points. Don't say "this part" or reference the fact it's a fragment — just state the points.\n\n"""${chunks[i]}"""`;
    partial.push(await callClaude(apiKey, model, prompt, 500));
  }

  onProgress?.(chunks.length + 1, chunks.length + 1);
  const combinePrompt = `Here are bullet-point summaries of consecutive sections of a document${title ? ` ("${title}")` : ""}. Combine them into one cohesive summary for the reader: a short overview paragraph, then the main takeaways as bullet points, removing redundancy between sections.\n\n${partial.map((p, i) => `Section ${i + 1}:\n${p}`).join("\n\n")}`;
  return callClaude(apiKey, model, combinePrompt, 1200);
}
