import { chromium, firefox } from "playwright-core";

const SAMPLE_PDF = "/usr/share/doc/fonts-lmodern/lm-info.pdf";
const SAMPLE_TXT = "/tmp/sample.txt";
const BASE_URL = "http://localhost:8934";
const isLocalStaticServer = BASE_URL.includes("localhost");
const BROWSER_NAME = process.env.BROWSER || "chromium"; // "chromium" or "firefox"

let browser, contextOptions;
if (BROWSER_NAME === "firefox") {
  // Uses Playwright's own patched Firefox build (npx playwright install firefox),
  // not the system firefox-esr — vanilla system Firefox doesn't speak Playwright's
  // automation protocol. Fake mic/camera via preferences rather than Chromium's
  // --use-fake-*-for-media-stream flags, which Firefox doesn't have.
  browser = await firefox.launch({ headless: true });
  contextOptions = {
    firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true },
  };
} else {
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-sandbox"],
  });
  contextOptions = { permissions: ["microphone"] };
}
const context = await browser.newContext(contextOptions);
const page = await context.newPage();

const errors = [];
page.on("console", (msg) => {
  const type = msg.type();
  if (type === "error" || type === "warning") {
    const line = `[console.${type}] ${msg.text()}`;
    errors.push(line);
  }
});
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));

let passed = 0, failed = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

await page.goto(`${BASE_URL}/index.html`);
await page.waitForTimeout(400);

// The `hidden` attribute is easy to silently defeat: any CSS class that sets its own
// `display` on the same element (flex/grid/etc.) wins over the UA's `[hidden]{display:
// none}` rule unless the stylesheet explicitly re-asserts it. Checking el.hidden (the
// IDL property) only proves the ATTRIBUTE is present — not that anything is actually
// invisible on screen. Assert real rendered visibility here so that class of bug can't
// silently return.
async function assertActuallyHidden(selector) {
  const isVisible = await page.$eval(selector, (el) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && el.offsetParent !== null;
  }).catch(() => false);
  if (isVisible) throw new Error(`${selector} has [hidden] set but is still visibly rendered`);
}

await step("Initially-hidden elements are actually not rendered (not just attribute-hidden)", async () => {
  for (const sel of ["#scroll-controls", "#voice-controls", "#progress-wrap", "#export-video-btn", "#selection-toolbar", "#side-panel", "#export-modal"]) {
    await assertActuallyHidden(sel);
  }
});

await step("PDF loads and renders pages", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(SAMPLE_PDF);
  await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });
  const pageCount = await page.$$eval(".pdf-page", (els) => els.length);
  if (pageCount < 2) throw new Error(`expected multiple pages, got ${pageCount}`);
});

await step("Auto-scroll play moves scrollTop", async () => {
  await page.click("#play-pause", { timeout: 4000 });
  await page.waitForTimeout(1000);
  const scrollTop = await page.$eval("#reader-pane", (el) => el.scrollTop);
  await page.click("#play-pause", { timeout: 4000 });
  if (scrollTop <= 0) throw new Error(`scrollTop did not advance (${scrollTop})`);
});

await step("Progress bar reflects scroll position", async () => {
  const val = await page.$eval("#progress-bar", (el) => parseInt(el.value, 10));
  if (val <= 0) throw new Error(`progress bar value is ${val}, expected > 0`);
});

await step("Export video modal opens/closes", async () => {
  await page.click("#export-video-btn", { timeout: 4000 });
  const visible = await page.$eval("#export-modal", (el) => !el.hidden);
  if (!visible) throw new Error("modal did not open");
  await page.click("#export-cancel-btn", { timeout: 4000 });
  const hiddenAfter = await page.$eval("#export-modal", (el) => el.hidden);
  if (!hiddenAfter) throw new Error("modal did not close");
});

await step("Export speed defaults to the current reading scroll speed", async () => {
  await page.fill("#scroll-speed", "150");
  await page.dispatchEvent("#scroll-speed", "input");
  await page.click("#export-video-btn", { timeout: 4000 });
  const exportSpeed = await page.$eval("#export-speed", (el) => el.value);
  if (exportSpeed !== "150") throw new Error(`expected export speed 150, got ${exportSpeed}`);
  await page.click("#export-cancel-btn", { timeout: 4000 });
  await page.fill("#scroll-speed", "60");
  await page.dispatchEvent("#scroll-speed", "input");
});

await step("Slide-by-slide animation mode hides the speed field", async () => {
  await page.click("#export-video-btn", { timeout: 4000 });
  await page.selectOption("#export-animation", "slides");
  const hidden = await page.$eval("#export-speed-field", (el) => el.hidden);
  if (!hidden) throw new Error("speed field should be hidden in slide mode");
  await page.selectOption("#export-animation", "scroll");
  const shownAgain = await page.$eval("#export-speed-field", (el) => !el.hidden);
  if (!shownAgain) throw new Error("speed field should reappear in scroll mode");
  await page.click("#export-cancel-btn", { timeout: 4000 });
});

await step("Load plain text doc with real prose", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(SAMPLE_TXT);
  await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });
  const blocks = await page.$$eval(".text-block", (els) => els.length);
  if (blocks < 2) throw new Error(`expected multiple text blocks, got ${blocks}`);
});

await step("Voice reader starts speaking then returns to idle", async () => {
  // Headless Chromium has no real TTS audio backend, so speechSynthesis utterances
  // can fire "end" almost instantly (unlike a real browser reading at real pace) —
  // assert on the state machine reaching idle again, rather than racing a live
  // click against however fast headless speech happens to finish.
  await page.click("#voice-play", { timeout: 4000 });
  const stopEnabled = await page.$eval("#voice-stop", (el) => !el.disabled);
  if (stopEnabled) await page.click("#voice-stop", { timeout: 4000 }).catch(() => {});
  await page.waitForFunction(
    () => document.getElementById("voice-play").textContent.includes("Read Aloud") && document.getElementById("voice-stop").disabled,
    { timeout: 4000 }
  );
});

await step("Notes panel saves to sessionStorage", async () => {
  await page.click("#tab-notes-btn", { timeout: 4000 });
  await page.fill("#notes-text", "hello from smoke test");
  const saved = await page.evaluate(() => sessionStorage.getItem("pdfScrollApp.notes"));
  if (saved !== "hello from smoke test") throw new Error(`got ${JSON.stringify(saved)}`);
});

await step("Notes download produces a file", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 4000 }),
    page.click("#notes-download-btn", { timeout: 4000 }),
  ]);
  const filename = download.suggestedFilename();
  if (!filename.endsWith(".md")) throw new Error(`unexpected filename ${filename}`);
});

await step("Settings panel shows the AI-is-ready info card, no key field", async () => {
  await page.click("#tab-settings-btn", { timeout: 4000 });
  const hasKeyInput = await page.$("#api-key-input");
  if (hasKeyInput) throw new Error("API key input should no longer exist");
  const cardText = await page.$eval(".ai-info-card", (el) => el.textContent).catch(() => "");
  if (!cardText.toLowerCase().includes("ready")) throw new Error("expected AI-ready info card");
});

await step("Only one side-panel tab is visible at a time (not stacked)", async () => {
  await assertActuallyHidden("#panel-notes"); // settings tab open from previous step
  const settingsVisible = await page.$eval("#panel-settings", (el) => getComputedStyle(el).display !== "none" && el.offsetParent !== null);
  if (!settingsVisible) throw new Error("expected #panel-settings to be visible");
});

await step("Sidebar can be resized by dragging its handle, and the width persists", async () => {
  const before = await page.$eval("#side-panel", (el) => el.getBoundingClientRect().width);
  const handleBox = await page.$eval("#side-panel-resizer", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  await page.mouse.move(handleBox.x, handleBox.y);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 120, handleBox.y, { steps: 8 }); // drag left = wider
  await page.mouse.up();

  const after = await page.$eval("#side-panel", (el) => el.getBoundingClientRect().width);
  if (after < before + 80) throw new Error(`expected sidebar to widen by ~120px, went from ${before} to ${after}`);

  const stored = await page.evaluate(() => localStorage.getItem("pdfScrollApp.sidebarWidth"));
  if (!stored || Math.abs(parseInt(stored, 10) - after) > 2) {
    throw new Error(`expected persisted width to match rendered width, got stored=${stored} rendered=${after}`);
  }

  await page.reload();
  await page.waitForTimeout(300);
  await page.click("#tab-settings-btn", { timeout: 4000 });
  const afterReload = await page.$eval("#side-panel", (el) => el.getBoundingClientRect().width);
  if (Math.abs(afterReload - after) > 2) throw new Error(`expected width to persist across reload, got ${afterReload} vs ${after}`);

  // Reload wiped the loaded document (same as the theme-reload test) — restore it.
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(SAMPLE_TXT);
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });
});

await step("Theme swatch applies data-theme and persists to localStorage", async () => {
  await page.click('.theme-swatch[data-theme="sage"]', { timeout: 4000 });
  const attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (attr !== "sage") throw new Error(`expected data-theme=sage, got ${attr}`);
  const stored = await page.evaluate(() => localStorage.getItem("pdfScrollApp.theme"));
  if (stored !== "sage") throw new Error(`expected localStorage sage, got ${stored}`);
  const activeCount = await page.$$eval(".theme-swatch.active", (els) => els.length);
  if (activeCount !== 1) throw new Error(`expected exactly 1 active swatch, got ${activeCount}`);
  const activeTheme = await page.$eval(".theme-swatch.active", (el) => el.dataset.theme);
  if (activeTheme !== "sage") throw new Error(`expected active swatch to be sage, got ${activeTheme}`);
});

await step("Chosen theme survives a reload with no flash (FOUC-prevention script)", async () => {
  await page.reload();
  const attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (attr !== "sage") throw new Error(`expected theme to persist as sage after reload, got ${attr}`);
  // Reset to auto so it doesn't leak into later tests/screenshots, and reload the
  // document since page.reload() wiped it for the tests that follow.
  await page.click("#tab-settings-btn", { timeout: 4000 });
  await page.click('.theme-swatch[data-theme="auto"]', { timeout: 4000 });
  await page.click("#tab-settings-btn", { timeout: 4000 }); // close panel
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(SAMPLE_TXT);
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });
});

await step("Document content stays readable (dark text on light paper) in every theme", async () => {
  for (const theme of ["dark", "lavender", "sage", "sky", "sand", "blush"]) {
    await page.click("#tab-settings-btn", { timeout: 4000 });
    await page.click(`.theme-swatch[data-theme="${theme}"]`, { timeout: 4000 });
    await page.click("#tab-settings-btn", { timeout: 4000 }); // close panel
    const { bg, color } = await page.$eval(".doc-flow-page", (el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    // Cheap luminance-order check rather than a full contrast ratio: background must
    // be light and text must be dark, regardless of which app theme is active.
    const luminance = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    if (luminance(bg) < 200) throw new Error(`[${theme}] expected light paper background, got ${bg}`);
    if (luminance(color) > 100) throw new Error(`[${theme}] expected dark text, got ${color}`);
  }
  await page.click("#tab-settings-btn", { timeout: 4000 });
  await page.click('.theme-swatch[data-theme="auto"]', { timeout: 4000 });
  await page.click("#tab-settings-btn", { timeout: 4000 });
});

await step("Selecting text shows the selection toolbar", async () => {
  await page.click("#tab-settings-btn", { timeout: 4000 }); // close panel
  const block = await page.$(".text-block");
  const box = await block.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    () => !document.getElementById("selection-toolbar").hidden,
    { timeout: 2000 }
  );
});

await step("Read-selection button speaks without crashing", async () => {
  await page.click("#read-selection-btn", { timeout: 4000 });
  await page.waitForTimeout(300);
});

await step("Ask AI returns a real answer from the server-side model", async () => {
  if (isLocalStaticServer) {
    console.log("  SKIP (local static file server has no /api/ai/* routes — only the deployed Worker does)");
    return;
  }
  await page.reload();
  await page.waitForTimeout(400);
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles(SAMPLE_TXT);
  await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });

  const block = await page.$(".text-block");
  const box = await block.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById("selection-toolbar").hidden, { timeout: 2000 });
  await page.click("#ask-ai-btn", { timeout: 4000 });
  await page.waitForFunction(
    () => document.getElementById("ai-output").textContent.trim().length > 0,
    { timeout: 20000 }
  );
  const answer = await page.$eval("#ai-output", (el) => el.textContent);
  if (answer.length < 10) throw new Error(`AI answer looked too short: ${JSON.stringify(answer)}`);
});

await step("Summarize returns a real summary from the server-side model", async () => {
  if (isLocalStaticServer) {
    console.log("  SKIP (local static file server has no /api/ai/* routes — only the deployed Worker does)");
    return;
  }
  await page.selectOption("#summarize-scope", "document");
  await page.click("#summarize-btn", { timeout: 4000 });
  await page.waitForFunction(
    () => document.getElementById("ai-output").textContent.trim().length > 0,
    { timeout: 20000 }
  );
  const summary = await page.$eval("#ai-output", (el) => el.textContent);
  if (summary.length < 10) throw new Error(`summary looked too short: ${JSON.stringify(summary)}`);
});

await step("DOCX loads via mammoth with multiple paragraphs", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample.docx");
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });
  const blocks = await page.$$eval(".text-block", (els) => els.length);
  const containerText = await page.$eval(".doc-flow-page", (el) => el.textContent);
  if (blocks < 3) throw new Error(`expected >=3 paragraphs, got ${blocks}`);
  if (!containerText.includes("Sample Report Title")) throw new Error(`unexpected content: ${containerText.slice(0, 120)}`);
});

await step("PPTX loads via JSZip with slide cards", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample.pptx");
  await page.waitForSelector(".slide-page", { timeout: 20000 });
  const slides = await page.$$eval(".slide-page", (els) => els.length);
  const firstTitle = await page.$eval(".slide-page h2", (el) => el.textContent);
  if (slides !== 2) throw new Error(`expected 2 slides, got ${slides}`);
  if (!firstTitle.includes("Welcome to the Sample Deck")) throw new Error(`unexpected slide title: ${firstTitle}`);
});

await step("PPTX title detected even without explicit type=\"title\" (real-world export quirk)", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample-realistic.pptx");
  await page.waitForSelector(".slide-page", { timeout: 20000 });
  const hasH2 = await page.$eval(".slide-page", (el) => !!el.querySelector("h2"));
  const title = await page.$eval(".slide-page h2", (el) => el.textContent).catch(() => null);
  const bodyItems = await page.$$eval(".slide-page li", (els) => els.map((e) => e.textContent));
  if (!hasH2 || !title.includes("Untyped Title Slide")) {
    throw new Error(`expected title "Untyped Title Slide" to be detected, got: ${JSON.stringify(title)}`);
  }
  if (bodyItems.some((t) => t.includes("Untyped Title Slide"))) {
    throw new Error("title text leaked into body bullets — title/body split failed");
  }
  if (bodyItems.length !== 2) throw new Error(`expected 2 body bullets, got ${bodyItems.length}`);
});

await step("HTML loads with content rendered and scripts/handlers stripped", async () => {
  await page.evaluate(() => { delete window.__pwned; delete window.__pwned2; delete window.__pwned3; });
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample.html");
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });

  const blocks = await page.$$eval(".text-block", (els) => els.length);
  if (blocks < 3) throw new Error(`expected >=3 blocks, got ${blocks}`);

  const containerText = await page.$eval(".doc-flow-page", (el) => el.textContent);
  if (!containerText.includes("HTML Fixture Title")) throw new Error(`unexpected content: ${containerText.slice(0, 120)}`);

  const scriptRan = await page.evaluate(() => window.__pwned === true);
  if (scriptRan) throw new Error("embedded <script> executed — sanitization failed");

  const hasOnclick = await page.$eval(".doc-flow-page", (el) => !!el.querySelector("[onclick]"));
  if (hasOnclick) throw new Error("onclick attribute was not stripped");

  const hasJsHref = await page.$eval(".doc-flow-page", (el) =>
    Array.from(el.querySelectorAll("a")).some((a) => (a.getAttribute("href") || "").startsWith("javascript:"))
  );
  if (hasJsHref) throw new Error("javascript: href was not stripped");

  // The bug this app actually shipped: stripping <style> outright discarded the CSS
  // class that gave this box its dark background, leaving its white text invisible
  // against the app's own white "paper" background.
  const { bg, color } = await page.$eval("#dark-box-text", (el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // Own background (dark) must win over the ancestor's white paper background —
  // otherwise white text sits directly on white and vanishes.
  if (luminance(bg) > 60) throw new Error(`expected the dark-box's own dark background to apply, got ${bg}`);
  if (luminance(color) < 200) throw new Error(`expected white text to stay white, got ${color}`);
});

await step("Markdown's embedded raw HTML is sanitized the same way as .html uploads", async () => {
  await page.evaluate(() => { delete window.__mdPwned; delete window.__mdPwned2; });
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample-styled.md");
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });

  const scriptRan = await page.evaluate(() => window.__mdPwned === true);
  if (scriptRan) throw new Error("embedded <script> in markdown executed — sanitization failed");
  const hasOnclick = await page.$eval(".doc-flow-page", (el) => !!el.querySelector("[onclick]"));
  if (hasOnclick) throw new Error("onclick attribute in markdown HTML was not stripped");

  const { bg, color } = await page.$eval("#md-dark-box-text", (el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  if (luminance(bg) > 60) throw new Error(`expected dark box background from embedded <style>, got ${bg}`);
  if (luminance(color) < 200) throw new Error(`expected white text to stay white, got ${color}`);
});

await step("DOCX/TXT get split into multiple slides in slide mode (not squeezed into one)", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample-long.txt");
  await page.waitForSelector(".doc-flow-page", { timeout: 20000 });
  const paragraphCount = await page.$$eval(".text-block", (els) => els.length);
  if (paragraphCount < 3) throw new Error(`fixture too short to test grouping (${paragraphCount} paragraphs)`);

  await page.click("#export-video-btn", { timeout: 4000 });
  await page.uncheck("#export-mic");
  await page.selectOption("#export-animation", "slides");

  let maxSlideTotal = 1;
  const statusHandle = setInterval(async () => {
    try {
      const text = await page.$eval("#export-status", (el) => el.textContent);
      const m = text.match(/slide \d+\/(\d+)/);
      if (m) maxSlideTotal = Math.max(maxSlideTotal, parseInt(m[1], 10));
    } catch { /* modal may have closed */ }
  }, 200);

  await page.click("#export-start-btn", { timeout: 4000 });
  await page.waitForSelector("#export-result:not([hidden])", { timeout: 90000 });
  clearInterval(statusHandle);
  await page.click("#export-close-btn", { timeout: 4000 });

  if (maxSlideTotal <= 1) throw new Error(`expected multiple slides for a ${paragraphCount}-paragraph doc, got ${maxSlideTotal}`);
});

// Checking only blob.src.startsWith("blob:") previously let a real bug through
// undetected across multiple deploys: an unconnected audio destination track (exactly
// what "mic off, no music" produces) corrupted the *entire* muxed output, not just the
// audio — every one of these "passing" tests was silently producing a ~110-byte,
// unplayable file. Fetching the actual blob and asserting a realistic minimum size is
// what would have caught it; a real few-second 1080px recording is invariably tens to
// hundreds of KB, so this threshold has wide margin without being a fragile exact match.
const MIN_VALID_VIDEO_BYTES = 5000;

for (const animation of ["scroll", "scrollZoom", "slides"]) {
  await step(`Video export produces a real, non-empty webm file (${animation}, sunrise theme, no mic)`, async () => {
    const fileInput = await page.$("#file-input");
    await fileInput.setInputFiles("/tmp/sample.txt");
    await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });

    await page.click("#export-video-btn", { timeout: 4000 });
    await page.uncheck("#export-mic"); // exactly the scenario that silently broke every prior "passing" run
    await page.selectOption("#export-animation", animation);
    await page.selectOption("#export-theme", "sunrise");
    if (animation !== "slides") await page.fill("#export-speed", "400"); // keep test fast
    await page.click("#export-start-btn", { timeout: 4000 });

    await page.waitForSelector("#export-result:not([hidden])", { timeout: 40000 });
    const videoInfo = await page.$eval("#export-preview-video", async (el) => {
      const hasSrc = !!el.src && el.src.startsWith("blob:");
      const res = await fetch(el.src);
      const buf = await res.arrayBuffer();
      return { hasSrc, byteLength: buf.byteLength };
    });
    if (!videoInfo.hasSrc) throw new Error("export video element has no blob src");
    if (videoInfo.byteLength < MIN_VALID_VIDEO_BYTES) {
      throw new Error(`exported file is only ${videoInfo.byteLength} bytes — looks like the broken-empty-container bug, not a real recording`);
    }
    await page.click("#export-close-btn", { timeout: 4000 });
  });
}

await step("Video export with mic narration (real connected audio source) is also non-empty", async () => {
  const fileInput = await page.$("#file-input");
  await fileInput.setInputFiles("/tmp/sample.txt");
  await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });

  await page.click("#export-video-btn", { timeout: 4000 });
  await page.selectOption("#export-animation", "scroll"); // previous test left it on "slides", which hides the speed field
  // Leave #export-mic checked (its default) — a real connected source, the other
  // branch of the audio-track fix, covered separately from the no-audio tests above.
  await page.fill("#export-speed", "400");
  await page.click("#export-start-btn", { timeout: 4000 });

  await page.waitForSelector("#export-result:not([hidden])", { timeout: 40000 });
  const videoInfo = await page.$eval("#export-preview-video", async (el) => {
    const res = await fetch(el.src);
    const buf = await res.arrayBuffer();
    return { byteLength: buf.byteLength };
  });
  if (videoInfo.byteLength < MIN_VALID_VIDEO_BYTES) {
    throw new Error(`exported file with mic enabled is only ${videoInfo.byteLength} bytes`);
  }
  await page.click("#export-close-btn", { timeout: 4000 });
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log("\n--- Console/page errors captured ---");
console.log(errors.length ? errors.join("\n") : "(none)");

await browser.close();
process.exit(failed ? 1 : 0);
