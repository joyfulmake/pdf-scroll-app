// Shared HTML sanitizer used by both the .html/.htm loader and the Markdown loader
// (marked.js passes raw embedded HTML straight through by default, so it needs the
// same treatment). Untrusted content — even a local file the user picked themselves —
// gets its scripts, event-handler attributes, and javascript: URLs stripped.
//
// Unlike a naive sanitizer, this does NOT discard <style> tags: real-world HTML pages
// almost always define their look (background/text color pairings especially) via
// CSS classes in a stylesheet, not inline attributes. Dropping stylesheets outright
// silently breaks color pairing — e.g. white text that depended on a dark box
// background defined by a class rule goes invisible once that rule is gone. Instead,
// styles are extracted and re-injected scoped to the container via @scope, so they
// can only affect this one piece of content, never leak out and affect the app shell.

const DISALLOWED_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "LINK", "META", "TITLE", "HEAD"]);

function sanitizeAttributes(el) {
  Array.from(el.attributes).forEach((attr) => {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
    } else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
      el.removeAttribute(attr.name);
    }
  });
}

function sanitizeTree(node) {
  Array.from(node.children).forEach((child) => {
    if (DISALLOWED_TAGS.has(child.tagName)) {
      child.remove();
      return;
    }
    sanitizeAttributes(child);
    sanitizeTree(child);
  });
}

// Redirects top-level html/body/:root rules to :scope — the most common way a page
// sets its overall background/text color — so those rules apply to our container
// instead of matching nothing and being silently dropped.
function scopeSelectors(css) {
  return css.replace(/(^|[{},])\s*(html|body|:root)\b(?![\w-])/gi, (_, pre) => `${pre} :scope`);
}

// Removes all <style> elements from the document (head and body) and returns their
// combined content as a single @scope-wrapped stylesheet, or "" if there were none.
function extractScopedStyles(doc, scopeSelector) {
  const styleEls = Array.from(doc.querySelectorAll("style"));
  const combined = styleEls.map((s) => s.textContent).join("\n");
  styleEls.forEach((s) => s.remove());
  if (!combined.trim()) return "";
  return `@scope (${scopeSelector}) {\n${scopeSelectors(combined)}\n}`;
}

// Parses a full or partial HTML string and returns sanitized body markup plus a
// scoped stylesheet safe to inject alongside it.
export function sanitizeHtmlDocument(rawHtml, scopeSelector) {
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
  const scopedCss = extractScopedStyles(parsed, scopeSelector);
  sanitizeTree(parsed.body);
  return { bodyHtml: parsed.body.innerHTML, scopedCss, title: parsed.title };
}
