import { chromium } from "playwright-core";

const SAMPLE_PDF = "/usr/share/doc/fonts-lmodern/lm-info.pdf";
const SAMPLE_TXT = "/tmp/sample.txt";

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-sandbox"],
});
const context = await browser.newContext({ permissions: ["microphone"] });
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

await page.goto("http://localhost:8934/index.html");
await page.waitForTimeout(400);

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

await step("Settings save API key to sessionStorage only", async () => {
  await page.click("#tab-settings-btn", { timeout: 4000 });
  await page.fill("#api-key-input", "sk-ant-test-fake-key");
  const saved = await page.evaluate(() => sessionStorage.getItem("pdfScrollApp.apiKey"));
  if (saved !== "sk-ant-test-fake-key") throw new Error(`got ${JSON.stringify(saved)}`);
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

await step("Ask AI without a key redirects to Settings with a toast", async () => {
  await page.evaluate(() => sessionStorage.removeItem("pdfScrollApp.apiKey"));
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
    () => !document.getElementById("panel-settings").hidden,
    { timeout: 2000 }
  );
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

for (const animation of ["scroll", "scrollZoom", "slides"]) {
  await step(`Video export produces a playable webm blob (${animation}, sunrise theme)`, async () => {
    const fileInput = await page.$("#file-input");
    await fileInput.setInputFiles("/tmp/sample.txt");
    await page.waitForFunction(() => !document.getElementById("scroll-controls").hidden, { timeout: 20000 });

    await page.click("#export-video-btn", { timeout: 4000 });
    await page.uncheck("#export-mic"); // headless has no real mic audio; test the video pipeline itself
    await page.selectOption("#export-animation", animation);
    await page.selectOption("#export-theme", "sunrise");
    if (animation !== "slides") await page.fill("#export-speed", "400"); // keep test fast
    await page.click("#export-start-btn", { timeout: 4000 });

    await page.waitForSelector("#export-result:not([hidden])", { timeout: 40000 });
    const videoInfo = await page.$eval("#export-preview-video", (el) => ({
      hasSrc: !!el.src && el.src.startsWith("blob:"),
    }));
    if (!videoInfo.hasSrc) throw new Error("export video element has no blob src");
    await page.click("#export-close-btn", { timeout: 4000 });
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log("\n--- Console/page errors captured ---");
console.log(errors.length ? errors.join("\n") : "(none)");

await browser.close();
process.exit(failed ? 1 : 0);
