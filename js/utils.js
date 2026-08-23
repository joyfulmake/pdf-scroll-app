export function showToast(message, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Splits a block of text into sentence-ish chunks for TTS + highlighting.
export function splitIntoSentences(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const matches = clean.match(/[^.!?]+[.!?]*(\s+|$)/g);
  return (matches || [clean]).map((s) => s.trim()).filter(Boolean);
}

export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export function timestamp() {
  return new Date().toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Finds the horizontal extent of actual content (text/graphics) on a rendered canvas,
// as a 0-1 fraction of its width. Used both by video export and the PDF reading view to
// zoom/pan into the real content column instead of showing a page's full width, print
// margins included — pixel-scanning is the only format-agnostic way to find this,
// since PDF pages in particular have no per-line DOM structure to measure (pdf.js hands
// back one flat rasterized page image, not positioned text nodes for the visible glyphs).
export function detectContentColumn(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return { left: 0, right: 1 };
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, w, h);
  const strideX = Math.max(1, Math.floor(w / 300));
  const strideY = Math.max(1, Math.floor(h / 300));
  let minX = w, maxX = -1;
  for (let y = 0; y < h; y += strideY) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x += strideX) {
      const idx = (rowOffset + x) * 4;
      const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (data[idx + 3] > 10 && lum < 245) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < minX) return { left: 0, right: 1 }; // blank page — nothing to zoom toward
  return { left: minX / w, right: clamp((maxX + strideX) / w, 0, 1) };
}
