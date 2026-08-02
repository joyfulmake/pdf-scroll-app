// Lightweight PPTX reader: extracts slide title/body text + images via JSZip + DOMParser.
// This is not a pixel-perfect PowerPoint renderer (fonts/positions/animations are not
// reproduced) — it builds a clean, readable "slide card" per slide, good enough for
// scrolling, narration, AI summarization, and video export.

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", bmp: "image/bmp", emf: "image/x-emf", wmf: "image/x-wmf",
};

function slideNumberOf(path) {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function readRelMap(zip, slidePath) {
  const relPath = slidePath.replace(/slides\/([^/]+)\.xml$/, "slides/_rels/$1.xml.rels");
  const relFile = zip.file(relPath);
  if (!relFile) return {};
  const xml = new DOMParser().parseFromString(await relFile.async("text"), "application/xml");
  const map = {};
  Array.from(xml.getElementsByTagName("Relationship")).forEach((rel) => {
    map[rel.getAttribute("Id")] = rel.getAttribute("Target");
  });
  return map;
}

// Real-world slides frequently omit an explicit type="title" and rely on the slide
// layout to supply it via idx="0" — Google Slides, Canva, and even some PowerPoint
// versions export this way. Without this fallback, those decks would have no
// detected title at all, and everything (title included) would flatten into one
// undifferentiated bullet list per slide.
function shapeIsExplicitTitle(sp) {
  const ph = sp.getElementsByTagName("p:ph")[0];
  if (!ph) return false;
  const type = ph.getAttribute("type") || "";
  if (type === "title" || type === "ctrTitle") return true;
  return !type && ph.getAttribute("idx") === "0";
}

function shapeText(sp) {
  const paragraphs = Array.from(sp.getElementsByTagName("a:p"));
  return paragraphs
    .map((p) => Array.from(p.getElementsByTagName("a:t")).map((t) => t.textContent).join(""))
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function loadPptx(arrayBuffer, container, filenameNoExt) {
  const zip = await window.JSZip.loadAsync(arrayBuffer);
  const slideFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

  const textBlocks = [];
  let deckTitle = filenameNoExt;

  for (let i = 0; i < slideFiles.length; i++) {
    const path = slideFiles[i];
    const xmlText = await zip.file(path).async("text");
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const shapes = Array.from(xml.getElementsByTagName("p:sp"));

    const shapesWithText = shapes
      .map((sp) => ({ lines: shapeText(sp), isExplicitTitle: shapeIsExplicitTitle(sp) }))
      .filter((s) => s.lines.length);

    // Prefer an explicitly-marked title placeholder; if no shape on this slide has
    // one (freeform text boxes only, no layout placeholders), fall back to treating
    // the first text-bearing shape as the title rather than losing structure entirely.
    const explicitIdx = shapesWithText.findIndex((s) => s.isExplicitTitle);
    let title = "";
    const bodyLines = [];
    shapesWithText.forEach((s, i) => {
      const useAsTitle = !title && (explicitIdx >= 0 ? i === explicitIdx : i === 0);
      if (useAsTitle) title = s.lines.join(" ");
      else bodyLines.push(...s.lines);
    });

    const relMap = await readRelMap(zip, path);
    const blips = Array.from(xml.getElementsByTagName("a:blip")).slice(0, 3);
    const images = [];
    for (const blip of blips) {
      const rId = blip.getAttribute("r:embed");
      const target = rId && relMap[rId];
      if (!target) continue;
      const mediaPath = "ppt/" + target.replace(/^\.\.\//, "");
      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;
      const ext = mediaPath.split(".").pop().toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue; // skip unsupported formats (emf/wmf can't display in <img>)
      const base64 = await mediaFile.async("base64");
      images.push(`data:${mime};base64,${base64}`);
    }

    if (!title && !bodyLines.length && !images.length) continue;
    if (i === 0 && title) deckTitle = title;

    const slideDiv = document.createElement("section");
    slideDiv.className = "doc-page slide-page text-block";

    if (title) {
      const h2 = document.createElement("h2");
      h2.textContent = title;
      slideDiv.appendChild(h2);
    }
    if (bodyLines.length) {
      const ul = document.createElement("ul");
      bodyLines.forEach((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      });
      slideDiv.appendChild(ul);
    }
    images.forEach((src) => {
      const img = document.createElement("img");
      img.src = src;
      img.style.maxHeight = "40%";
      img.style.objectFit = "contain";
      img.style.marginTop = "8px";
      slideDiv.appendChild(img);
    });
    const num = document.createElement("span");
    num.className = "slide-number";
    num.textContent = `Slide ${i + 1} / ${slideFiles.length}`;
    slideDiv.appendChild(num);

    container.appendChild(slideDiv);
    textBlocks.push({
      el: slideDiv,
      text: [title, ...bodyLines].join(". "),
      label: `Slide ${i + 1}`,
    });
  }

  return { title: deckTitle, kind: "pptx", textBlocks };
}
