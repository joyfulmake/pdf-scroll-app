// Uses the globally-loaded `mammoth` (vendor/mammoth/mammoth.browser.min.js, loaded via <script> in index.html).

export async function loadDocx(arrayBuffer, container, filenameNoExt) {
  const result = await window.mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: window.mammoth.images.imgElement((image) =>
        image.read("base64").then((data) => ({ src: `data:${image.contentType};base64,${data}` }))
      ),
    }
  );

  const page = document.createElement("article");
  page.className = "doc-page doc-flow-page";
  page.innerHTML = result.value;
  container.appendChild(page);

  const textBlocks = [];
  const blockSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
  page.querySelectorAll(blockSelector).forEach((el) => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    el.classList.add("text-block");
    textBlocks.push({ el, text, label: null });
  });

  const heading = page.querySelector("h1, h2");
  return {
    title: heading ? heading.textContent.trim() : filenameNoExt,
    kind: "docx",
    textBlocks,
  };
}
