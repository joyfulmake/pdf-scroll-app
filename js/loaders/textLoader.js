// Uses the globally-loaded `marked` (vendor/marked/marked.min.js) for markdown rendering.

export async function loadText(text, isMarkdown, container, filenameNoExt) {
  const page = document.createElement("article");
  page.className = "doc-page doc-flow-page";

  if (isMarkdown && window.marked) {
    page.innerHTML = window.marked.parse(text);
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
