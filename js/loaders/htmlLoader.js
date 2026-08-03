import { sanitizeHtmlDocument } from "./sanitizeHtml.js";

export async function loadHtml(rawHtml, container, filenameNoExt) {
  const page = document.createElement("article");
  page.className = "doc-page doc-flow-page";
  // Gives the original document's own CSS a scoping root to attach to (see
  // sanitizeHtmlDocument / @scope) — a unique id so multiple loaded files never clash.
  page.id = `html-doc-${Math.random().toString(36).slice(2, 9)}`;

  const { bodyHtml, scopedCss, title } = sanitizeHtmlDocument(rawHtml, `#${page.id}`);

  if (scopedCss) {
    const styleEl = document.createElement("style");
    styleEl.textContent = scopedCss;
    page.appendChild(styleEl);
  }

  const content = document.createElement("div");
  content.innerHTML = bodyHtml;
  page.appendChild(content);
  container.appendChild(page);

  const textBlocks = [];
  const blockSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th";
  page.querySelectorAll(blockSelector).forEach((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (!t) return;
    el.classList.add("text-block");
    textBlocks.push({ el, text: t, label: null });
  });

  if (!textBlocks.length) {
    // No recognizable block elements (e.g. a page built entirely from <div>s) — fall
    // back to treating the whole body's text as one block so it's still readable.
    const t = content.textContent.replace(/\s+/g, " ").trim();
    if (t) {
      const p = document.createElement("p");
      p.textContent = t;
      p.classList.add("text-block");
      content.appendChild(p);
      textBlocks.push({ el: p, text: t, label: null });
    }
  }

  const heading = page.querySelector("h1, h2");
  return {
    title: (heading?.textContent || title || filenameNoExt).trim(),
    kind: "html",
    textBlocks,
  };
}
