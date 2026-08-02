// Renders an uploaded .html/.htm file. This is untrusted content (even though it's a
// local file the user picked themselves), so scripts, styles, and event-handler
// attributes are stripped via DOMParser before anything is inserted into the page —
// no arbitrary script execution, no fighting with the app's own CSS.

const DISALLOWED_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TITLE", "HEAD"]);

function sanitize(node) {
  Array.from(node.children).forEach((child) => {
    if (DISALLOWED_TAGS.has(child.tagName)) {
      child.remove();
      return;
    }
    Array.from(child.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        child.removeAttribute(attr.name);
      } else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        child.removeAttribute(attr.name);
      }
    });
    sanitize(child);
  });
}

export async function loadHtml(rawHtml, container, filenameNoExt) {
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
  sanitize(parsed.body);

  const page = document.createElement("article");
  page.className = "doc-page doc-flow-page";
  page.innerHTML = parsed.body.innerHTML;
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
    const t = (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
    if (t) {
      const p = document.createElement("p");
      p.textContent = t;
      p.classList.add("text-block");
      page.appendChild(p);
      textBlocks.push({ el: p, text: t, label: null });
    }
  }

  const heading = page.querySelector("h1, h2");
  return {
    title: (heading?.textContent || parsed.title || filenameNoExt).trim(),
    kind: "html",
    textBlocks,
  };
}
