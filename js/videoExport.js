// Renders the currently-loaded document (PDF, DOCX, PPTX, TXT/MD all go through this
// the same way) into a tall offscreen "filmstrip" image, then plays a scripted
// animation of it on an export canvas while MediaRecorder captures it — combined with
// your microphone narration (and an optional quiet music bed) — into a downloadable
// .webm video. .webm is a natively-supported upload format on LinkedIn and most social
// platforms.
//
// PDF and PPTX render as one `.doc-page` per page/slide already, so each is a natural
// caption/slide unit. DOCX and TXT/MD render as a single continuous `.doc-page`
// (Word/Markdown don't have fixed pagination), so — to keep captions moving and slide
// mode showing sensible screen-sized chunks instead of the whole document squeezed into
// one frame — this module further divides those into segments using the same
// paragraph-level `doc.textBlocks` the rest of the app already tracks for voice/AI sync.

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
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

  await new Promise((r) => setTimeout(r, holdMs));
}

async function rasterizeElement(el, targetWidth) {
  const existingCanvas = el.querySelector(":scope > canvas");
  if (existingCanvas) return existingCanvas;
  const scale = Math.min(2, targetWidth / el.clientWidth || 1);
  return window.html2canvas(el, { backgroundColor: "#ffffff", scale, useCORS: true });
}

async function buildPages(pagesContainer, targetWidth, onStatus) {
  const pageEls = Array.from(pagesContainer.querySelectorAll(":scope > .doc-page"));
  const rendered = [];
  for (let i = 0; i < pageEls.length; i++) {
    onStatus?.(`Rendering page ${i + 1} of ${pageEls.length}…`);
    const el = pageEls[i];
    const srcCanvas = await rasterizeElement(el, targetWidth);
    const height = Math.round(srcCanvas.height * (targetWidth / srcCanvas.width));
    rendered.push({ srcCanvas, height, el });
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
  for (const r of rendered) {
    ctx.drawImage(r.srcCanvas, 0, y, targetWidth, r.height);
    y += r.height;
  }
  return { filmstrip, totalHeight };
}

// One entry per *natural content unit*: a whole page for PDF/PPTX (each is already its
// own `.doc-page` with one matching textBlock), or one per paragraph for DOCX/TXT/MD
// (many textBlocks inside a single `.doc-page`) — so captions and slide breaks land in
// sensible places for every format instead of only working correctly for PDF.
function computeAtomicSegments(rendered, doc) {
  const segments = [];
  let cumY = 0;
  for (let pageIndex = 0; pageIndex < rendered.length; pageIndex++) {
    const { el, height: pageHeight } = rendered[pageIndex];
    const elRect = el.getBoundingClientRect();
    const blocksInside = doc.textBlocks.filter((b) => el.contains(b.el));
    const units = blocksInside.length
      ? blocksInside.map((b) => {
          const r = b.el.getBoundingClientRect();
          return { text: b.text, top: r.top - elRect.top, height: r.height || 1 };
        })
      : [{ text: el.textContent || "", top: 0, height: elRect.height || 1 }];
    units.sort((a, b) => a.top - b.top);

    for (const u of units) {
      const fracTop = elRect.height > 0 ? u.top / elRect.height : 0;
      const fracHeight = elRect.height > 0 ? u.height / elRect.height : 1;
      const pageLocalStartY = fracTop * pageHeight;
      const pageLocalEndY = pageLocalStartY + fracHeight * pageHeight;
      segments.push({
        startY: cumY + pageLocalStartY,
        endY: cumY + pageLocalEndY,
        pageLocalStartY,
        pageLocalEndY,
        pageIndex,
        text: cleanText(u.text).slice(0, 240),
      });
    }
    cumY += pageHeight;
  }
  return segments;
}

// Groups atomic segments into screen-sized chunks (capped at one page each, so a group
// never straddles two different rasterized page canvases) for slide-by-slide mode.
function groupIntoSlides(segments, targetChunkHeight) {
  const groups = [];
  let current = null;
  for (const seg of segments) {
    const currentHeight = current ? current.pageLocalEndY - current.pageLocalStartY : 0;
    if (!current || current.pageIndex !== seg.pageIndex || currentHeight >= targetChunkHeight * 0.9) {
      if (current) groups.push(current);
      current = { pageIndex: seg.pageIndex, pageLocalStartY: seg.pageLocalStartY, pageLocalEndY: seg.pageLocalEndY, texts: [seg.text] };
    } else {
      current.pageLocalEndY = seg.pageLocalEndY;
      current.texts.push(seg.text);
    }
  }
  if (current) groups.push(current);
  return groups.map((g) => ({ ...g, text: cleanText(g.texts.join(" ")).slice(0, 240) }));
}

function nativeCropForGroup(rendered, group) {
  const page = rendered[group.pageIndex];
  const nativeScale = page.srcCanvas.height / page.height;
  const srcY = group.pageLocalStartY * nativeScale;
  const srcH = Math.max(1, (group.pageLocalEndY - group.pageLocalStartY) * nativeScale);
  return { srcCanvas: page.srcCanvas, srcY, srcH };
}

// Rough narration-pace estimate for how long to hold each slide before advancing.
function dwellMsFor(text) {
  return clamp((text.length / 18) * 1000, 2500, 8000);
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

function drawContainFrame(ctx, W, H, srcCanvas, srcY, srcH, theme, alpha = 1) {
  const srcW = srcCanvas.width;
  const scale = Math.min(W / srcW, H / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(srcCanvas, 0, srcY, srcW, srcH, dx, dy, dw, dh);
  ctx.restore();
}

async function animateSlides({ ctx, rendered, groups, W, H, theme, wantCaptions, onStatus, isCancelled }) {
  const TRANSITION_MS = 450;

  for (let i = 0; i < groups.length; i++) {
    if (isCancelled()) return;
    const group = groups[i];
    const crop = nativeCropForGroup(rendered, group);
    onStatus?.(`Recording… slide ${i + 1}/${groups.length}`);

    const dwell = dwellMsFor(group.text);
    const holdStart = performance.now();
    while (performance.now() - holdStart < dwell) {
      if (isCancelled()) return;
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      drawContainFrame(ctx, W, H, crop.srcCanvas, crop.srcY, crop.srcH, theme);
      if (wantCaptions) drawCaption(ctx, W, H, theme, group.text);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const nextGroup = groups[i + 1];
    if (!nextGroup) continue;
    const nextCrop = nativeCropForGroup(rendered, nextGroup);
    const transStart = performance.now();
    while (true) {
      if (isCancelled()) return;
      const t = Math.min(1, (performance.now() - transStart) / TRANSITION_MS);
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      drawContainFrame(ctx, W, H, crop.srcCanvas, crop.srcY, crop.srcH, theme, 1 - t);
      drawContainFrame(ctx, W, H, nextCrop.srcCanvas, nextCrop.srcY, nextCrop.srcH, theme, t);
      if (wantCaptions) drawCaption(ctx, W, H, theme, t < 0.5 ? group.text : nextGroup.text);
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
  const rendered = await buildPages(pagesContainer, W, onStatus);
  const atomicSegments = computeAtomicSegments(rendered, doc);

  let filmstrip = null, totalHeight = 0, slideGroups = null;
  if (animation === "slides") {
    slideGroups = groupIntoSlides(atomicSegments, H);
  } else {
    ({ filmstrip, totalHeight } = buildFilmstrip(rendered, W));
  }

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
          ctx, rendered, groups: slideGroups, W, H, theme, wantCaptions, onStatus,
          isCancelled: () => cancelToken.cancelled,
        });
      } else {
        await animateScroll({
          ctx, filmstrip, segments: atomicSegments, W, H, totalHeight, speed, style: animation, theme, wantCaptions, onStatus,
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
