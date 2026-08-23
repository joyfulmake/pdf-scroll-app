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

import { clamp, detectContentColumn } from "./utils.js";

const ASPECTS = {
  square: { w: 1080, h: 1080, label: "Square 1:1 (LinkedIn feed)" },
  vertical: { w: 1080, h: 1920, label: "Vertical 9:16 (Stories/Reels)" },
  landscape: { w: 1920, h: 1080, label: "Landscape 16:9 (YouTube/wide)" },
  landscapeClassic: { w: 1440, h: 1080, label: "Landscape 4:3 (closer fit for document pages)" },
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

async function paintTitleCard(ctx, W, H, title, theme, holdMs, isCancelled) {
  // canvas.captureStream() does not reliably emit frames from elapsed time alone —
  // Chrome (and others) only actually capture a frame when the canvas is repainted.
  // Drawing once and then just `await sleep(holdMs)` (the original approach here)
  // produces a recording with zero real video data for the entire hold, because
  // nothing ever repaints during it — confirmed empirically: an isolated draw-once-
  // then-wait test produced a near-empty, unplayable output, while an identical test
  // that repainted every frame in a loop produced a full, valid one. So the title
  // card must redraw every frame during its hold, same as the scroll/slide loops
  // already correctly do.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, theme.grad[0]);
  grad.addColorStop(1, theme.grad[1]);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(W * 0.065)}px -apple-system, sans-serif`;
  const lines = wrapLines(ctx, title, W * 0.8);
  const lineHeight = W * 0.085;
  const startY = H / 2 - ((lines.length - 1) * lineHeight) / 2;

  const start = performance.now();
  while (performance.now() - start < holdMs) {
    if (isCancelled?.()) return;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(W * 0.065)}px -apple-system, sans-serif`;
    lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));
    ctx.fillStyle = theme.accent;
    ctx.font = `500 ${Math.round(W * 0.022)}px -apple-system, sans-serif`;
    ctx.fillText("PDF Scroll Reader", W / 2, startY + lines.length * lineHeight + W * 0.05);
    await new Promise((r) => requestAnimationFrame(r));
  }
}

// html2canvas bundles its own CSS color parser (predates CSS Color 4) that throws
// outright — aborting the whole export — the instant it encounters color-mix(),
// oklch(), oklab(), lab(), lch(), or color(). Real browsers parse and render all of
// these fine, so a real-world .html/.md upload with its own modern stylesheet (or even
// just this app's own `<style>` blocks, in principle) can trip this the moment
// html2canvas walks it. Rather than trying to hand-reimplement CSS colorimetry, this
// asks the actual browser to resolve each occurrence to a plain rgb()/rgba() string
// (via a throwaway element's computed style) and substitutes that in — works uniformly
// for every unsupported function without needing to special-case any of them.
const UNSUPPORTED_COLOR_FNS = ["color-mix", "oklch", "oklab", "lab", "lch", "color"];

// getComputedStyle() is *not* a safe way to resolve these — its own reported computed
// value can itself be oklab()/oklch() rather than always normalizing to rgb() (confirmed
// empirically: assigning a color-mix() came back as an oklab() string), which would
// just trade one unsupported function for another. A 1x1 canvas fillStyle + pixel
// readback always resolves to concrete sRGB bytes regardless of what color space the
// input was specified in, since canvas painting has to rasterize to real pixels.
function resolveToRgbString(colorText, ctx) {
  ctx.fillStyle = "#000000";
  ctx.fillStyle = colorText; // silently ignored if invalid — falls back to the reset black
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

function resolveModernColorFunctions(cssText, ctx) {
  let result = "";
  let i = 0;
  while (i < cssText.length) {
    const name = UNSUPPORTED_COLOR_FNS.find((n) => cssText.startsWith(`${n}(`, i));
    if (!name) { result += cssText[i]; i++; continue; }
    let depth = 0, j = i + name.length;
    for (; j < cssText.length; j++) {
      if (cssText[j] === "(") depth++;
      else if (cssText[j] === ")" && --depth === 0) { j++; break; }
    }
    result += resolveToRgbString(cssText.slice(i, j), ctx);
    i = j;
  }
  return result;
}

function neutralizeUnsupportedColors(clonedDoc) {
  const hasUnsupported = (text) => UNSUPPORTED_COLOR_FNS.some((n) => text.includes(`${n}(`));
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.canvas.width = 1;
  ctx.canvas.height = 1;
  clonedDoc.querySelectorAll("style").forEach((styleEl) => {
    if (hasUnsupported(styleEl.textContent)) styleEl.textContent = resolveModernColorFunctions(styleEl.textContent, ctx);
  });
  clonedDoc.querySelectorAll("[style]").forEach((el) => {
    const attr = el.getAttribute("style") || "";
    if (hasUnsupported(attr)) el.setAttribute("style", resolveModernColorFunctions(attr, ctx));
  });
}

async function rasterizeElement(el, targetWidth) {
  const existingCanvas = el.querySelector(":scope > canvas");
  if (existingCanvas) return existingCanvas;
  const scale = Math.min(2, targetWidth / el.clientWidth || 1);
  return window.html2canvas(el, { backgroundColor: "#ffffff", scale, useCORS: true, onclone: neutralizeUnsupportedColors });
}

async function buildPages(pagesContainer, targetWidth, onStatus) {
  const pageEls = Array.from(pagesContainer.querySelectorAll(":scope > .doc-page"));
  const rendered = [];
  for (let i = 0; i < pageEls.length; i++) {
    onStatus?.(`Rendering page ${i + 1} of ${pageEls.length}…`);
    const el = pageEls[i];
    const srcCanvas = await rasterizeElement(el, targetWidth);
    const height = Math.round(srcCanvas.height * (targetWidth / srcCanvas.width));
    const contentColumn = detectContentColumn(srcCanvas);
    rendered.push({ srcCanvas, height, el, contentColumn });
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
    const { el, height: pageHeight, contentColumn } = rendered[pageIndex];
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
        // Horizontal extent of real content vs. margin, as a 0-1 fraction of the page's
        // width — detected from the rendered pixels (see detectContentColumn), since
        // PDF's textBlock is the whole page and carries no per-line horizontal info.
        // Same value for every segment on a page: the zoom adjusts per page, not
        // per-line, which is where the margin actually changes.
        fracLeft: contentColumn.left,
        fracWidth: contentColumn.right - contentColumn.left,
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

// Merges atomic segments' Y-ranges (padded slightly so the slow-down eases in just
// ahead of the text rather than at its exact pixel edge) into non-overlapping "content"
// bands. Everything outside those bands is margin/whitespace, where the scroll can move
// through faster without anything readable flying past.
// Each band also carries the horizontal extent (0-1 fraction of page width) of the
// content inside it, unioned across whatever segments merged into it — this is what
// lets the frame zoom in on just the text column instead of showing the page's full
// width, margins included.
function buildContentBands(segments) {
  const pad = 8;
  const sorted = segments
    .map((s) => ({ start: Math.max(0, s.startY - pad), end: s.endY + pad, hLeft: s.fracLeft, hRight: clamp(s.fracLeft + s.fracWidth, 0, 1) }))
    .sort((a, b) => a.start - b.start);
  const bands = [];
  for (const r of sorted) {
    const last = bands[bands.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.hLeft = Math.min(last.hLeft, r.hLeft);
      last.hRight = Math.max(last.hRight, r.hRight);
    } else {
      bands.push({ ...r });
    }
  }
  return bands;
}

// Y offsets where the scroll should briefly hold right before it starts — a beat that
// reads as "it noticed the blank stretch it just crossed and is about to start reading
// again," rather than firing at a fixed pixel seam that may sit well before the next
// page's text actually begins (e.g. a page with a large top margin). Only fires ahead of
// a *real* blank stretch (a page transition, a section break) — small inter-paragraph
// spacing is left alone so continuous prose doesn't stutter on every line.
const MIN_GAP_FOR_PAUSE = 60;

function contentRevealYs(bands) {
  const ys = [];
  let prevEnd = 0;
  for (const b of bands) {
    if (b.start - prevEnd >= MIN_GAP_FOR_PAUSE) ys.push(b.start);
    prevEnd = b.end;
  }
  return ys;
}

// Content always scrolls at the caller's configured (readable) speed — never slowed
// down further, never artificially padded out. Margins/whitespace move much faster
// (GAP_SPEED_MULTIPLIER) since there's nothing there to read. The only adjustment on
// top of that natural pace is a speed-*up*, and only once a document is long enough
// that reading it at face value would run past a sane viewing length: compress toward
// SOFT_MAX_DURATION_S first, but never push the content scroll faster than
// MAX_CONTENT_SPEEDUP× its configured pace to get there — a truly long document is
// instead allowed to run longer (up to the hard HARD_MAX_DURATION_S ceiling) rather
// than becoming unreadably fast.
const SOFT_MAX_DURATION_S = 180; // 3 min: typical documents shouldn't generally run past this
const HARD_MAX_DURATION_S = 300; // 5 min: absolute ceiling, even for very large documents
const MAX_CONTENT_SPEEDUP = 2.5; // how much faster than configured pace content may be pushed to hit the soft target
const GAP_SPEED_MULTIPLIER = 6; // how much faster than reading pace margins/whitespace move

function estimateRawDurationS(bands, maxY, pauseCount, readSpeed) {
  const contentHeight = bands.reduce((s, b) => s + (Math.min(b.end, maxY) - Math.min(b.start, maxY)), 0);
  const gapHeight = Math.max(0, maxY - contentHeight);
  const contentTime = readSpeed > 0 ? contentHeight / readSpeed : 0;
  const gapTime = readSpeed > 0 ? gapHeight / (readSpeed * GAP_SPEED_MULTIPLIER) : 0;
  const pauseTime = (pauseCount * CONTENT_REVEAL_HOLD_MS) / 1000;
  return contentTime + gapTime + pauseTime;
}

// Never returns more than rawDuration (this only ever compresses, never stretches).
function targetDurationFor(rawDuration) {
  if (rawDuration <= SOFT_MAX_DURATION_S) return rawDuration;
  if (rawDuration / SOFT_MAX_DURATION_S <= MAX_CONTENT_SPEEDUP) return SOFT_MAX_DURATION_S;
  return clamp(rawDuration / MAX_CONTENT_SPEEDUP, SOFT_MAX_DURATION_S, HARD_MAX_DURATION_S);
}

function speedAt(y, bands, contentSpeed, gapSpeed) {
  for (const b of bands) {
    if (y < b.start) return gapSpeed;
    if (y < b.end) return contentSpeed;
  }
  return gapSpeed;
}

// How far past a content band's tightest bounding box the crop keeps as breathing room,
// and how far in it's ever allowed to zoom — a cap so a single short heading doesn't
// get blown up to fill the whole frame edge-to-edge.
const CROP_PADDING_FRAC = 0.08;
const CONTENT_MAX_ZOOM = 2.2;
// "scrollZoom" style layers its own slow, continuous zoom on top of the content crop —
// this is that effect's ceiling, applied as an extra multiplier over the video's length.
const KEN_BURNS_MAX = 1.08;

// Where the frame should be centered/zoomed horizontally at a given scroll position: the
// band containing y, or — while still crossing the gap leading up to it — the *next*
// band, so the zoom has already settled into place by the time that content arrives
// rather than snapping the instant it appears. Falls back to the full page width when
// there's no nearby band (e.g. past the last one).
function cropTargetAt(y, bands) {
  for (const b of bands) {
    if (y < b.end) {
      const width = Math.max(1e-6, b.hRight - b.hLeft);
      const pad = width * CROP_PADDING_FRAC;
      const left = clamp(b.hLeft - pad, 0, 1);
      const right = clamp(b.hRight + pad, 0, 1);
      const zoom = clamp(1 / Math.max(right - left, 1 / CONTENT_MAX_ZOOM), 1, CONTENT_MAX_ZOOM);
      return { center: (left + right) / 2, zoom };
    }
  }
  return { center: 0.5, zoom: 1 };
}

function drawScrollFrame({ ctx, filmstrip, W, H, totalHeight, offsetY, style, t, theme, wantCaptions, segments, cropCenter, cropZoom }) {
  ctx.clearRect(0, 0, W, H);
  const extraZoom = style === "scrollZoom" ? 1 + t * (KEN_BURNS_MAX - 1) : 1;
  const zoom = cropZoom * extraZoom;
  const srcW = W / zoom;
  const srcH = H / zoom;
  const srcX = clamp(cropCenter * W - srcW / 2, 0, Math.max(0, W - srcW));
  const srcY = clamp(offsetY + (H - srcH) / 2, 0, Math.max(0, totalHeight - srcH));
  ctx.drawImage(filmstrip, srcX, srcY, srcW, srcH, 0, 0, W, H);
  if (wantCaptions) {
    const focusY = srcY + srcH * 0.4;
    const seg = segments.find((s) => focusY >= s.startY && focusY < s.endY) || segments[segments.length - 1];
    drawCaption(ctx, W, H, theme, seg?.text);
  }
}

const CONTENT_REVEAL_HOLD_MS = 500;
// Time constants for easing the scroll speed and the crop/zoom toward their targets
// instead of snapping — a soft ramp reads as deliberate, an instant jump reads as a
// glitch. The crop eases more slowly than the speed does: a pan/zoom that settles in
// gently is the whole point, unlike the speed changes which should feel prompt.
const SPEED_EASE_TAU = 0.35;
const CROP_EASE_TAU = 0.5;

async function animateScroll({ ctx, filmstrip, segments, W, H, totalHeight, speed, style, theme, wantCaptions, onStatus, isCancelled }) {
  const maxY = Math.max(0, totalHeight - H);
  const bands = buildContentBands(segments);
  const pendingReveals = contentRevealYs(bands);

  const rawDuration = estimateRawDurationS(bands, maxY, pendingReveals.length, speed);
  const targetDuration = targetDurationFor(rawDuration);
  const durationScale = rawDuration > 0 ? rawDuration / targetDuration : 1;
  const contentSpeed = speed * durationScale;
  const gapSpeed = speed * GAP_SPEED_MULTIPLIER * durationScale;

  let offsetY = 0;
  let currentSpeed = speedAt(0, bands, contentSpeed, gapSpeed);
  const initialCrop = cropTargetAt(0, bands);
  let cropCenter = initialCrop.center;
  let cropZoom = initialCrop.zoom;
  let lastTick = performance.now();

  const easeCrop = (dt) => {
    const target = cropTargetAt(offsetY, bands);
    const k = 1 - Math.exp(-dt / CROP_EASE_TAU);
    cropCenter += (target.center - cropCenter) * k;
    cropZoom += (target.zoom - cropZoom) * k;
  };

  while (true) {
    if (isCancelled()) return;
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    const targetSpeed = speedAt(offsetY, bands, contentSpeed, gapSpeed);
    currentSpeed += (targetSpeed - currentSpeed) * (1 - Math.exp(-dt / SPEED_EASE_TAU));
    offsetY = Math.min(maxY, offsetY + currentSpeed * dt);
    easeCrop(dt);

    // Pause right as a blank stretch is about to give way to real content again — not
    // at a fixed pixel seam, which can sit well before the text if a page has a big top
    // margin. Redraws every frame throughout the hold (a static canvas produces no real
    // captured video, per exportVideo's title card handling above).
    if (pendingReveals.length && offsetY >= pendingReveals[0]) {
      offsetY = Math.min(maxY, pendingReveals.shift());
      const holdStart = performance.now();
      let holdLastTick = holdStart;
      while (performance.now() - holdStart < CONTENT_REVEAL_HOLD_MS) {
        if (isCancelled()) return;
        const holdNow = performance.now();
        easeCrop((holdNow - holdLastTick) / 1000);
        holdLastTick = holdNow;
        drawScrollFrame({ ctx, filmstrip, W, H, totalHeight, offsetY, style, t: maxY > 0 ? offsetY / maxY : 0, theme, wantCaptions, segments, cropCenter, cropZoom });
        onStatus?.(`Recording… ${Math.round((offsetY / maxY) * 100 || 100)}%`);
        await new Promise((r) => requestAnimationFrame(r));
      }
      lastTick = performance.now();
    }

    drawScrollFrame({ ctx, filmstrip, W, H, totalHeight, offsetY, style, t: maxY > 0 ? offsetY / maxY : 0, theme, wantCaptions, segments, cropCenter, cropZoom });
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

// A "contain" fit (drawContainFrame above) never crops the page, but when the page's
// aspect ratio is far from the frame's (a tall portrait document page in a wide 16:9
// frame, say) it leaves large flat bars on whichever sides don't touch — previously
// filled with a flat theme color, which read as the content being squeezed into a
// strip with dead space either side rather than filling the video. This fills those
// bars with a blurred, darkened "cover" crop of the *same* page instead, so the frame
// looks fully occupied while the sharp, complete page still sits centered on top.
// Built once per slide (not redrawn every animation frame) since canvas blur filters
// are too costly to re-run 30 times a second.
function buildBlurredBackdrop(W, H, srcCanvas, srcY, srcH) {
  const backdrop = document.createElement("canvas");
  backdrop.width = W;
  backdrop.height = H;
  const bctx = backdrop.getContext("2d");
  const srcW = srcCanvas.width;
  // Overscan the cover-fit crop so the blur kernel always samples real image content
  // near the frame edges rather than the canvas's (transparent) outside.
  const scale = Math.max(W / srcW, H / srcH) * 1.2;
  const dw = srcW * scale;
  const dh = srcH * scale;
  bctx.filter = `blur(${Math.round(W * 0.025)}px) brightness(0.55)`;
  bctx.drawImage(srcCanvas, 0, srcY, srcW, srcH, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return backdrop;
}

// Same soft/hard viewing-length ceiling as scroll mode (see targetDurationFor above),
// applied by uniformly compressing each slide's dwell time — never stretched, only
// ever squeezed once the deck as a whole would otherwise run past the target length.
function scaleDwellTimes(groups) {
  const TRANSITION_MS = 450;
  const natural = groups.reduce((s, g) => s + dwellMsFor(g.text), 0) + Math.max(0, groups.length - 1) * TRANSITION_MS;
  const targetMs = targetDurationFor(natural / 1000) * 1000;
  const scale = natural > 0 ? targetMs / natural : 1;
  return groups.map((g) => clamp(dwellMsFor(g.text) * scale, 800, 8000));
}

async function animateSlides({ ctx, rendered, groups, W, H, theme, wantCaptions, onStatus, isCancelled }) {
  const TRANSITION_MS = 450;
  const dwellTimes = scaleDwellTimes(groups);
  const backdropFor = (group) => {
    const crop = nativeCropForGroup(rendered, group);
    return buildBlurredBackdrop(W, H, crop.srcCanvas, crop.srcY, crop.srcH);
  };

  for (let i = 0; i < groups.length; i++) {
    if (isCancelled()) return;
    const group = groups[i];
    const crop = nativeCropForGroup(rendered, group);
    const backdrop = backdropFor(group);
    onStatus?.(`Recording… slide ${i + 1}/${groups.length}`);

    const dwell = dwellTimes[i];
    const holdStart = performance.now();
    while (performance.now() - holdStart < dwell) {
      if (isCancelled()) return;
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(backdrop, 0, 0);
      drawContainFrame(ctx, W, H, crop.srcCanvas, crop.srcY, crop.srcH, theme);
      if (wantCaptions) drawCaption(ctx, W, H, theme, group.text);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const nextGroup = groups[i + 1];
    if (!nextGroup) continue;
    const nextCrop = nativeCropForGroup(rendered, nextGroup);
    const nextBackdrop = backdropFor(nextGroup);
    const transStart = performance.now();
    while (true) {
      if (isCancelled()) return;
      const t = Math.min(1, (performance.now() - transStart) / TRANSITION_MS);
      ctx.fillStyle = theme.slideBg;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.drawImage(backdrop, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = t;
      ctx.drawImage(nextBackdrop, 0, 0);
      ctx.restore();
      drawContainFrame(ctx, W, H, crop.srcCanvas, crop.srcY, crop.srcH, theme, 1 - t);
      drawContainFrame(ctx, W, H, nextCrop.srcCanvas, nextCrop.srcY, nextCrop.srcH, theme, t);
      if (wantCaptions) drawCaption(ctx, W, H, theme, t < 0.5 ? group.text : nextGroup.text);
      if (t >= 1) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
}

// Ordered by preference: modern webm/vp9 first, down through older webm variants,
// down to plain mp4 last — Safari versions before 18.4 (March 2025) only ever
// supported mp4/h264 for MediaRecorder and returned false for every webm variant, so
// without this fallback chain those browsers would fail outright instead of still
// producing a (less efficient, but valid and shareable) mp4 file.
// Deliberately does NOT include an explicit "video/webm;codecs=vp8,opus" candidate:
// confirmed by direct isolated testing that at least one real Firefox build reports
// it as supported via isTypeSupported() and even transitions MediaRecorder.state to
// "inactive" on stop(), but then never fires the 'stop'/'dataavailable' events at
// all — the recording hangs forever with zero output. The bare "video/webm" entry
// below still lets such browsers record (letting them pick their own default codec
// instead of forcing vp8+opus explicitly) without hitting that failure mode.
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4",
];

function pickSupportedMimeType() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

// Checked up front, before requesting microphone permission or doing any rendering
// work, so unsupported browsers get one clear message immediately instead of failing
// partway through with a more confusing error.
export function checkVideoExportSupport() {
  if (typeof MediaRecorder === "undefined") {
    return "Video export needs the MediaRecorder API, which this browser doesn't have. Try a recent Chrome, Edge, Firefox, or Safari 18.4+.";
  }
  if (!document.createElement("canvas").captureStream) {
    return "Video export needs canvas.captureStream, which this browser doesn't support. Try a recent Chrome, Edge, Firefox, or Safari.";
  }
  if (!pickSupportedMimeType()) {
    return "This browser's MediaRecorder doesn't support any video format this app can produce (webm or mp4). Try a recent Chrome, Edge, Firefox, or Safari 18.4+.";
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    return "Video export needs the Web Audio API, which this browser doesn't have.";
  }
  if (typeof AudioContext !== "undefined" && !AudioContext.prototype.createMediaStreamDestination) {
    return "This browser's Web Audio API can't produce an audio track for recording (createMediaStreamDestination unsupported).";
  }
  return null; // supported
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
  const unsupportedReason = checkVideoExportSupport();
  if (unsupportedReason) throw new Error(unsupportedReason);
  const mimeType = pickSupportedMimeType();

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

  // A MediaStreamAudioDestinationNode with nothing actually connected to it still
  // produces a "live" audio track — but including that track in the recorded
  // MediaStream breaks the recording entirely (not just silent audio: the whole
  // muxed output comes back empty/unplayable). Confirmed empirically: identical
  // video-only recordings worked correctly, and recordings with a real connected
  // source (mic or an oscillator standing in for one) worked correctly, but adding
  // an unconnected destination's track — exactly what happens when neither mic nor
  // music is requested — reproduced a broken, near-empty file every time. So only
  // create the audio graph, and only include an audio track at all, when a real
  // source will actually feed it.
  const wantsAnyAudio = wantMic || !!musicFile;
  let audioCtx = null;
  let destination = null;
  let micStream = null;
  let musicNode = null;

  if (wantsAnyAudio) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // iOS Safari creates AudioContext in a "suspended" state until explicitly resumed
    // from within a user-gesture call stack — this call is (the export is started by
    // a click), but resuming explicitly avoids a silent, hard-to-diagnose no-audio
    // result if that assumption ever doesn't hold.
    if (audioCtx.state === "suspended") await audioCtx.resume();
    destination = audioCtx.createMediaStreamDestination();

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
  }

  const videoStream = previewCanvas.captureStream(30);
  const audioTracks = destination ? destination.stream.getAudioTracks() : [];
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
  const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  recorder.start();
  if (musicNode) musicNode.start();
  onStatus?.("Recording…");

  try {
    if (wantTitleCard && !cancelToken.cancelled) {
      await paintTitleCard(ctx, W, H, doc.title || "Document", theme, 3000, () => cancelToken.cancelled);
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
    if (audioCtx) await audioCtx.close();
  }

  return new Blob(chunks, { type: mimeType });
}
