// Uses the globally-loaded `marked` (vendor/marked/marked.min.js) for markdown rendering.
import { sanitizeHtmlDocument } from "./sanitizeHtml.js";

export async function loadText(text, isMarkdown, container, filenameNoExt) {
  const page = document.createElement("article");
  page.className = "doc-page doc-flow-page";
  page.id = `text-doc-${Math.random().toString(36).slice(2, 9)}`;

  if (isMarkdown && window.marked) {
    // marked.js passes any raw HTML embedded in the source straight through by
    // default — sanitize it the same way an uploaded .html file would be, since a
    // .md file can smuggle in scripts/handlers (or CSS that assumes a stylesheet
    // this app doesn't have) just as easily.
    const rendered = window.marked.parse(text);
    const { bodyHtml, scopedCss } = sanitizeHtmlDocument(rendered, `#${page.id}`);
    if (scopedCss) {
      const styleEl = document.createElement("style");
      styleEl.textContent = scopedCss;
      page.appendChild(styleEl);
    }
    const content = document.createElement("div");
    content.innerHTML = bodyHtml;
    page.appendChild(content);
  } else {
    text
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((para) => {
        const p = document.createElement("p");
        p.textContent = para;
        page.appendChild(p);
      });
  }

  container.appendChild(page);

  const textBlocks = [];
  const blockSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre";
  page.querySelectorAll(blockSelector).forEach((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (!t) return;
    el.classList.add("text-block");
    textBlocks.push({ el, text: t, label: null });
  });

  const heading = page.querySelector("h1, h2");
  return {
    title: heading ? heading.textContent.trim() : filenameNoExt,
    kind: isMarkdown ? "markdown" : "text",
    textBlocks,
  };
}
