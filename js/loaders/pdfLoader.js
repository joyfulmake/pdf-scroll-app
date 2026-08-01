import * as pdfjsLib from "../../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

const CMAP_URL = new URL("../../vendor/pdfjs/cmaps/", import.meta.url).href;
const FONT_URL = new URL("../../vendor/pdfjs/standard_fonts/", import.meta.url).href;

const TARGET_CSS_WIDTH = 760;

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
    const cssScale = TARGET_CSS_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale: cssScale * dpr });

    const wrapper = document.createElement("div");
    wrapper.className = "doc-page pdf-page text-block";
    wrapper.style.width = `${TARGET_CSS_WIDTH}px`;
    wrapper.style.height = `${viewport.height / dpr}px`;

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${TARGET_CSS_WIDTH}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    wrapper.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    wrapper.appendChild(textLayerDiv);

    const cssViewport = page.getViewport({ scale: cssScale });
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
