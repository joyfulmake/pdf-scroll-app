// Renders the currently-loaded document (any supported format — PDF, DOCX, PPTX,
// TXT/MD all go through this the same way, since they all end up as stacked .doc-page
// elements) into a tall offscreen "filmstrip" image, then plays a scripted animation of
// it on an export canvas while MediaRecorder captures it — combined with your
// microphone narration (and an optional quiet music bed) — into a downloadable .webm
// video. .webm is a natively-supported upload format on LinkedIn and most social platforms.

const ASPECTS = {
  square: { w: 1080, h: 1080, label: "Square 1:1 (LinkedIn feed)" },
  vertical: { w: 1080, h: 1920, label: "Vertical 9:16 (Stories/Reels)" },
  landscape: { w: 1920, h: 1080, label: "Landscape 16:9" },
};

const THEMES = {
  classic: { name: "Classic", grad: ["#3b2f74", "#7c5cff"], slideBg: "#211a3d", caption: "rgba(15, 10, 30, 0.6)", accent: "#a78bfa" },
  midnight: { name: "Midnight", grad: ["#0b0e14", "#1f2a44"], slideBg: "#0b0e14", caption: "rgba(0, 0, 0, 0.65)", accent: "#5b8cff" },
  sunrise: { name: "Sunrise", grad: ["#ff7a59", "#ffb347"], slideBg: "#3a1f12", caption: "rgba(50, 24, 10, 0.6)", accent: "#ffb347" },
  mono: { name: "Mono", grad: ["#1c1c1c", "#585858"], slideBg: "#1c1c1c", caption: "rgba(0, 0, 0, 0.6)", accent: "#e5e5e5" },
};

const ANIMATIONS = {
  scroll: { name: "Smooth scroll" },
  scrollZoom: { name: "Smooth scroll + slow zoom" },
  slides: { name: "Slide-by-slide (crossfade)" },
};

export { ASPECTS, THEMES, ANIMATIONS };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

async function paintTitleCard(ctx, W, H, title, theme, holdMs) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, theme.grad[0]);
  grad.addColorStop(1, theme.grad[1]);
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

  ctx.fillStyle = theme.accent;
  ctx.font = `500 ${Math.round(W * 0.022)}px -apple-system, sans-serif`;
  ctx.fillText("PDF Scroll Reader", W / 2, startY + lines.length * lineHeight + W * 0.05);

  await sleep(holdMs);
}

async function rasterizeElement(el, targetWidth) {
  const existingCanvas = el.querySelector(":scope > canvas");
  if (existingCanvas) return existingCanvas;
  const scale = Math.min(2, targetWidth / el.clientWidth || 1);
  return window.html2canvas(el, { backgroundColor: "#ffffff", scale, useCORS: true });
}

function captionFor(doc, el) {
  const blocksInside = doc.textBlocks.filter((b) => el.contains(b.el));
  return (blocksInside.map((b) => b.text).join(" ") || el.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// Rough narration-pace estimate for how long to hold each slide before advancing.
function dwellMsFor(text) {
  return clamp((text.length / 18) * 1000, 2500, 8000);
}

async function buildPages(pagesContainer, doc, targetWidth, onStatus) {
  const pageEls = Array.from(pagesContainer.querySelectorAll(":scope > .doc-page"));
  const rendered = [];
  for (let i = 0; i < pageEls.length; i++) {
    onStatus?.(`Rendering page ${i + 1} of ${pageEls.length}…`);
    const el = pageEls[i];
    const srcCanvas = await rasterizeElement(el, targetWidth);
    const height = Math.round(srcCanvas.height * (targetWidth / srcCanvas.width));
    rendered.push({ srcCanvas, height, caption: captionFor(doc, el) });
  }
  return rendered;
}

function buildFilmstrip(rendered, targetWidth) {
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
    segments.push({ startY: y, endY: y + r.height, text: r.caption });
    y += r.height;
  }
  return { filmstrip, segments, totalHeight };
}

function drawCaption(ctx, W, H, theme, text) {
  if (!text) return;
  const barHeight = Math.round(H * 0.16);
  ctx.fillStyle = theme.caption;
  ctx.fillRect(0, H - barHeight, W, barHeight);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, H - barHeight, W, 3);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const fontSize = Math.round(W * 0.028);
  ctx.font = `500 ${fontSize}px -apple-system, sans-serif`;
  const pad = W * 0.03;
  const lines = wrapLines(ctx, text, W - pad * 2).slice(0, 3);
  lines.forEach((line, i) => ctx.fillText(line, pad, H - barHeight + pad * 0.6 + i * (fontSize * 1.35)));
}

async function animateScroll({ ctx, filmstrip, segments, W, H, totalHeight, speed, style, theme, wantCaptions, onStatus, isCancelled }) {
  const maxY = Math.max(0, totalHeight - H);
  const duration = speed > 0 ? maxY / speed : 0;
  const start = performance.now();
  const maxZoom = 1.08;

  while (true) {
    if (isCancelled()) return;
    const elapsedSec = (performance.now() - start) / 1000;
    const offsetY = Math.min(maxY, elapsedSec * speed);

    ctx.clearRect(0, 0, W, H);
    if (style === "scrollZoom") {
      const t = duration > 0 ? Math.min(1, elapsedSec / duration) : 0;
      const zoom = 1 + t * (maxZoom - 1);
      const srcW = W / zoom;
      const srcH = H / zoom;
      const srcX = (W - srcW) / 2;
      const srcY = clamp(offsetY + (H - srcH) / 2, 0, Math.max(0, totalHeight - srcH));
      ctx.drawImage(filmstrip, srcX, srcY, srcW, srcH, 0, 0, W, H);
    } else {
      ctx.drawImage(filmstrip, 0, offsetY, W, H, 0, 0, W, H);
    }

    if (wantCaptions) {
      const seg = segments.find((s) => offsetY + H * 0.4 >= s.startY && offsetY + H * 0.4 < s.endY) || segments[segments.length - 1];
      drawCaption(ctx, W, H, theme, seg?.text);
    }

    onStatus?.(`Recording… ${Math.round((offsetY / maxY) * 100 || 100)}%`);

    if (offsetY >= maxY) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function drawContainFrame(ctx, W, H, srcCanvas, srcHeight, theme, alpha = 1) {
  const scale = Math.min(W / srcCanvas.width, H / srcHeight);
  const dw = srcCanvas.width * scale;
  const dh = srcHeight * scale;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcHeight, dx, dy, dw, dh);
  ctx.restore();
}

async function animateSlides({ ctx, rendered, W, H, theme, wantCaptions, onStatus, isCancelled }) {
  const TRANSITION_MS = 450;

  for (let i = 0; i < rendered.length; i++) {
    if (isCancelled()) return;
    const entry = rendered[i];
    onStatus?.(`Recording… slide ${i + 1}/${rendered.length}`);

    const dwell = dwellMsFor(entry.caption);
    const holdStart = performance.now();
    while (performance.now() - holdStart < dwell) {
      if (isCancelled()) return;
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      drawContainFrame(ctx, W, H, entry.srcCanvas, entry.height, theme);
      if (wantCaptions) drawCaption(ctx, W, H, theme, entry.caption);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const next = rendered[i + 1];
    if (!next) continue;
    const transStart = performance.now();
    while (true) {
      if (isCancelled()) return;
      const t = Math.min(1, (performance.now() - transStart) / TRANSITION_MS);
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      drawContainFrame(ctx, W, H, entry.srcCanvas, entry.height, theme, 1 - t);
      drawContainFrame(ctx, W, H, next.srcCanvas, next.height, theme, t);
      if (wantCaptions) drawCaption(ctx, W, H, theme, t < 0.5 ? entry.caption : next.caption);
      if (t >= 1) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
}

export async function exportVideo({
  pagesContainer,
  doc,
  previewCanvas,
  aspect = "square",
  speed = 40,
  animation = "scroll",
  theme: themeKey = "classic",
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
  const theme = THEMES[themeKey] || THEMES.classic;
  previewCanvas.width = W;
  previewCanvas.height = H;
  const ctx = previewCanvas.getContext("2d", { willReadFrequently: true });

  onStatus?.("Preparing pages…");
  const rendered = await buildPages(pagesContainer, doc, W, onStatus);
  const { filmstrip, segments, totalHeight } = animation === "slides"
    ? { filmstrip: null, segments: null, totalHeight: 0 }
    : buildFilmstrip(rendered, W);

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
      await paintTitleCard(ctx, W, H, doc.title || "Document", theme, 3000);
    }
    if (!cancelToken.cancelled) {
      if (animation === "slides") {
        await animateSlides({
          ctx, rendered, W, H, theme, wantCaptions, onStatus,
          isCancelled: () => cancelToken.cancelled,
        });
      } else {
        await animateScroll({
          ctx, filmstrip, segments, W, H, totalHeight, speed, style: animation, theme, wantCaptions, onStatus,
          isCancelled: () => cancelToken.cancelled,
        });
      }
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
