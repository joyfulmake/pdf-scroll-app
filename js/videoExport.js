// Renders the currently-loaded document into a tall offscreen "filmstrip" image (PDF
// pages are reused directly from their already-rendered canvases; docx/pptx/text pages
// are rasterized with html2canvas), then plays a scripted scroll of that filmstrip on an
// export canvas while MediaRecorder captures it — combined with your microphone
// narration (and an optional quiet music bed) — into a downloadable .webm video.
// .webm is a natively-supported upload format on LinkedIn and most social platforms.

const ASPECTS = {
  square: { w: 1080, h: 1080, label: "Square 1:1 (LinkedIn feed)" },
  vertical: { w: 1080, h: 1920, label: "Vertical 9:16 (Stories/Reels)" },
  landscape: { w: 1920, h: 1080, label: "Landscape 16:9" },
};

export { ASPECTS };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function paintTitleCard(ctx, W, H, title, holdMs, onElapsed) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#3b2f74");
  grad.addColorStop(1, "#7c5cff");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(W * 0.065)}px -apple-system, sans-serif`;
  const lines = wrapLines(ctx, title, W * 0.8);
  const lineHeight = W * 0.085;
  const startY = H / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));

  const steps = Math.max(1, Math.round(holdMs / 100));
  for (let i = 0; i < steps; i++) {
    await sleep(holdMs / steps);
    onElapsed?.();
  }
}

async function rasterizeElement(el, targetWidth) {
  const existingCanvas = el.querySelector(":scope > canvas");
  if (existingCanvas) return existingCanvas;
  const scale = Math.min(2, targetWidth / el.clientWidth || 1);
  return window.html2canvas(el, { backgroundColor: "#ffffff", scale, useCORS: true });
}

async function buildFilmstrip(pagesContainer, doc, targetWidth, onStatus) {
  const pageEls = Array.from(pagesContainer.querySelectorAll(":scope > .doc-page"));
  const rendered = [];
  for (let i = 0; i < pageEls.length; i++) {
    onStatus?.(`Rendering page ${i + 1} of ${pageEls.length}…`);
    const el = pageEls[i];
    const srcCanvas = await rasterizeElement(el, targetWidth);
    const height = Math.round(srcCanvas.height * (targetWidth / srcCanvas.width));
    rendered.push({ srcCanvas, height, el });
  }

  const totalHeight = rendered.reduce((s, r) => s + r.height, 0) || 1;
  const filmstrip = document.createElement("canvas");
  filmstrip.width = targetWidth;
  filmstrip.height = totalHeight;
  const ctx = filmstrip.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetWidth, totalHeight);

  let y = 0;
  const segments = [];
  for (const r of rendered) {
    ctx.drawImage(r.srcCanvas, 0, y, targetWidth, r.height);
    const blocksInside = doc.textBlocks.filter((b) => r.el.contains(b.el));
    const captionText = (blocksInside.map((b) => b.text).join(" ") || r.el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    segments.push({ startY: y, endY: y + r.height, text: captionText });
    y += r.height;
  }

  return { filmstrip, segments, totalHeight };
}

function drawCaption(ctx, W, H, text) {
  if (!text) return;
  const barHeight = Math.round(H * 0.16);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, H - barHeight, W, barHeight);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const fontSize = Math.round(W * 0.028);
  ctx.font = `500 ${fontSize}px -apple-system, sans-serif`;
  const pad = W * 0.03;
  const lines = wrapLines(ctx, text, W - pad * 2).slice(0, 3);
  lines.forEach((line, i) => ctx.fillText(line, pad, H - barHeight + pad * 0.6 + i * (fontSize * 1.35)));
}

async function animateScroll({ ctx, filmstrip, segments, W, H, totalHeight, speed, wantCaptions, onStatus, isCancelled }) {
  const maxY = Math.max(0, totalHeight - H);
  const start = performance.now();
  let currentSegText = "";

  while (true) {
    if (isCancelled()) return;
    const elapsedSec = (performance.now() - start) / 1000;
    const offsetY = Math.min(maxY, elapsedSec * speed);

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(filmstrip, 0, offsetY, W, H, 0, 0, W, H);

    if (wantCaptions) {
      const seg = segments.find((s) => offsetY + H * 0.4 >= s.startY && offsetY + H * 0.4 < s.endY) || segments[segments.length - 1];
      if (seg) currentSegText = seg.text;
      drawCaption(ctx, W, H, currentSegText);
    }

    onStatus?.(`Recording… ${Math.round((offsetY / maxY) * 100 || 100)}%`);

    if (offsetY >= maxY) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
}

export async function exportVideo({
  pagesContainer,
  doc,
  previewCanvas,
  aspect = "square",
  speed = 40,
  wantTitleCard = true,
  wantCaptions = true,
  wantMic = true,
  musicFile = null,
  cancelToken = { cancelled: false },
  onStatus,
}) {
  if (typeof MediaRecorder === "undefined" || !previewCanvas.captureStream) {
    throw new Error("Video export isn't supported in this browser. Try a recent Chrome, Edge, or Firefox.");
  }

  const { w: W, h: H } = ASPECTS[aspect];
  previewCanvas.width = W;
  previewCanvas.height = H;
  const ctx = previewCanvas.getContext("2d");

  onStatus?.("Preparing pages…");
  const { filmstrip, segments, totalHeight } = await buildFilmstrip(pagesContainer, doc, W, onStatus);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioCtx.createMediaStreamDestination();
  let micStream = null;
  let musicNode = null;

  if (wantMic) {
    onStatus?.("Requesting microphone…");
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx.createMediaStreamSource(micStream).connect(destination);
  }
  if (musicFile) {
    const buf = await musicFile.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(buf);
    musicNode = audioCtx.createBufferSource();
    musicNode.buffer = audioBuffer;
    musicNode.loop = true;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.18;
    musicNode.connect(gain).connect(destination);
  }

  const videoStream = previewCanvas.captureStream(30);
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  recorder.start();
  if (musicNode) musicNode.start();
  onStatus?.("Recording…");

  try {
    if (wantTitleCard && !cancelToken.cancelled) {
      await paintTitleCard(ctx, W, H, doc.title || "Document", 3000, () => {});
    }
    if (!cancelToken.cancelled) {
      await animateScroll({
        ctx, filmstrip, segments, W, H, totalHeight, speed, wantCaptions, onStatus,
        isCancelled: () => cancelToken.cancelled,
      });
    }
  } finally {
    recorder.stop();
    micStream?.getTracks().forEach((t) => t.stop());
    try { musicNode?.stop(); } catch { /* already stopped */ }
    await stopped;
    await audioCtx.close();
  }

  return new Blob(chunks, { type: "video/webm" });
}
