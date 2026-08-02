// Calls this app's own server-side AI proxy — Cloudflare Workers AI, bound directly to
// the Worker that serves this page. No API key to obtain or paste in: the model runs
// on Cloudflare's free tier, and credentials never exist in the browser at all.

const CHUNK_CHARS = 6000;

class AiError extends Error {}

async function callApi(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError("Couldn't reach the AI service — check your internet connection.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AiError(data.error || `AI request failed (${res.status}).`);
  }
  return data.text || "";
}

export async function explainSelection(selectedText, surroundingContext) {
  return callApi("/api/ai/explain", { selectedText, context: surroundingContext.slice(0, 3000) });
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

export async function summarizeText(fullText, { title, onProgress } = {}) {
  const chunks = chunkText(fullText);

  if (chunks.length <= 1) {
    onProgress?.(1, 1);
    return callApi("/api/ai/summarize", { text: fullText, title, isChunk: false });
  }

  const partial = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i + 1, chunks.length + 1);
    partial.push(
      await callApi("/api/ai/summarize", { text: chunks[i], title, isChunk: true, partIndex: i + 1, partTotal: chunks.length })
    );
  }

  onProgress?.(chunks.length + 1, chunks.length + 1);
  return callApi("/api/ai/combine", { summaries: partial, title });
}
