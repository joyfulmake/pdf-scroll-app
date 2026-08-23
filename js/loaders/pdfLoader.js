import * as pdfjsLib from "../../vendor/pdfjs/pdf.min.mjs";
import { clamp, detectContentColumn } from "../utils.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

const CMAP_URL = new URL("../../vendor/pdfjs/cmaps/", import.meta.url).href;
const FONT_URL = new URL("../../vendor/pdfjs/standard_fonts/", import.meta.url).href;

const TARGET_CSS_WIDTH = 760;
// PDFs are frequently typeset with generous print margins, which makes the actual text
// look small once shown at a fixed reading width. Each page gets zoomed/panned in on
// its own text column to counter that — padded by CONTENT_PADDING_FRAC so text doesn't
// sit flush against the edge, capped by CONTENT_MAX_ZOOM so a nearly-blank page (or one
// with a small centered figure) doesn't get blown up absurdly. Uses pdf.js's own
// offsetX viewport option (not a CSS transform) so the canvas and the invisible
// text-selection layer stay pixel-perfect aligned, and the wrapper's real DOM height
// reflects the zoomed size — no risk of desyncing scroll/progress tracking, which reads
// live layout geometry rather than a cached size.
const CONTENT_PADDING_FRAC = 0.06;
const CONTENT_MAX_ZOOM = 1.6;
const PROBE_WIDTH = 350;

// A cheap low-res render purely to find where the text column is (see
// detectContentColumn in utils.js) — pdf.js hands back one flat rasterized page image
// per page, no per-line DOM structure to measure the column from directly.
async function detectPageContentColumn(page, baseViewport) {
  const probeScale = Math.min(1, PROBE_WIDTH / baseViewport.width);
  const probeViewport = page.getViewport({ scale: probeScale });
  const probeCanvas = document.createElement("canvas");
  probeCanvas.width = Math.max(1, Math.round(probeViewport.width));
  probeCanvas.height = Math.max(1, Math.round(probeViewport.height));
  await page.render({ canvasContext: probeCanvas.getContext("2d"), viewport: probeViewport }).promise;
  return detectContentColumn(probeCanvas);
}

export async function loadPdf(arrayBuffer, container, onProgress) {
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
  });

  const pdf = await loadingTask.promise;
  const textBlocks = [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let title = null;
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title || null;
  } catch { /* metadata is optional */ }

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });

    const column = await detectPageContentColumn(page, baseViewport);
    const pad = Math.max(1e-6, column.right - column.left) * CONTENT_PADDING_FRAC;
    const paddedLeft = clamp(column.left - pad, 0, 1);
    const paddedRight = clamp(column.right + pad, 0, 1);
    const zoom = clamp(1 / Math.max(paddedRight - paddedLeft, 1 / CONTENT_MAX_ZOOM), 1, CONTENT_MAX_ZOOM);
    const shownWidthFrac = 1 / zoom;
    const shownLeft = clamp((paddedLeft + paddedRight) / 2 - shownWidthFrac / 2, 0, 1 - shownWidthFrac);

    const cssScale = (TARGET_CSS_WIDTH / baseViewport.width) * zoom;
    const renderScale = cssScale * dpr;
    const offsetX = -shownLeft * baseViewport.width * renderScale;
    const viewport = page.getViewport({ scale: renderScale, offsetX });

    const wrapper = document.createElement("div");
    wrapper.className = "doc-page pdf-page text-block";
    wrapper.style.width = `${TARGET_CSS_WIDTH}px`;
    wrapper.style.height = `${viewport.height / dpr}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(TARGET_CSS_WIDTH * dpr);
    canvas.height = viewport.height;
    canvas.style.width = `${TARGET_CSS_WIDTH}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    wrapper.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    wrapper.appendChild(textLayerDiv);

    const cssViewport = page.getViewport({ scale: cssScale, offsetX: offsetX / dpr });
    const textContent = await page.getTextContent();
    await new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerDiv,
      viewport: cssViewport,
    }).render();

    const pageText = textContent.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();

    container.appendChild(wrapper);
    textBlocks.push({ el: wrapper, text: pageText, label: `Page ${pageNum}` });

    onProgress?.(pageNum, pdf.numPages);
  }

  return {
    title: title || null,
    kind: "pdf",
    textBlocks,
  };
}
