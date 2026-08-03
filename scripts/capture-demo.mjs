// Regenerates assets/demo.gif and assets/og-image.png's source frames.
//
// Usage:
//   npm install --no-save playwright-core
//   DEMO_URL=https://pdf-scroll-app.pages.dev node scripts/capture-demo.mjs
//   python3 scripts/make-gif.py
//
// Runs against a live deployed URL (not the local static file server) since the
// "Ask AI" step needs the real Workers AI backend to capture a genuine response.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEMO_URL = process.env.DEMO_URL || "https://pdf-scroll-app.pages.dev";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const OUT_DIR = "/tmp/demo-frames";

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = [];
let frameIndex = 0;

async function capture(page, holdMs) {
  const name = `frame-${String(frameIndex).padStart(3, "0")}.png`;
  await page.screenshot({ path: `${OUT_DIR}/${name}` });
  manifest.push({ file: name, holdMs });
  frameIndex++;
}

const browser = await chromium.launch({
  executablePath: CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1000, height: 625 },
  permissions: ["microphone"],
});
const page = await context.newPage();

await page.goto(DEMO_URL);
await page.waitForTimeout(400);

// 1. Landing hero
await capture(page, 1400);

// 2. Load the demo document
const fileInput = await page.$("#file-input");
await fileInput.setInputFiles(path.join(SCRIPT_DIR, "demo-article.txt"));
await page.waitForSelector(".doc-flow-page", { timeout: 20000 });
await page.waitForTimeout(200);
await capture(page, 700);

// 3-5. Auto-scroll a few frames
await page.click("#play-pause");
await page.waitForTimeout(500);
await capture(page, 350);
await page.waitForTimeout(500);
await capture(page, 350);
await page.waitForTimeout(500);
await capture(page, 350);
await page.click("#play-pause"); // pause
await page.evaluate(() => document.getElementById("reader-pane").scrollTo({ top: 0 }));
await page.waitForTimeout(200);

// 6-7. Read Aloud — headless Chromium's TTS has no real audio backend and finishes
// near-instantly (unlike a real browser reading at a real pace), so the highlight
// never survives long enough to screenshot via the real flow. It's already verified
// correct elsewhere (test/smoke.mjs); toggle the same class it applies, just for an
// accurate capture here.
await page.evaluate(() => {
  document.getElementById("voice-play").textContent = "⏸ Pause";
  document.getElementById("voice-stop").disabled = false;
});
const blocks = await page.$$(".text-block");
const secondBlock = blocks[1] || blocks[0];
await secondBlock.evaluate((el) => el.classList.add("reading-active"));
await capture(page, 900);
await capture(page, 900);
await secondBlock.evaluate((el) => el.classList.remove("reading-active"));
await page.evaluate(() => {
  document.getElementById("voice-play").textContent = "🔊 Read Aloud";
  document.getElementById("voice-stop").disabled = true;
});

// 8-9. Select text, show the highlight toolbar — the "highlight catches your
// attention" paragraph, a fittingly meta choice, selected corner-to-corner for a
// clean full-paragraph selection rather than a single mid-line drag.
await page.evaluate(() => document.getElementById("reader-pane").scrollTo({ top: 0 }));
await page.waitForTimeout(200);
const selectableBlocks = await page.$$(".text-block");
const targetBlock = selectableBlocks[3] || selectableBlocks[0];
const box = await targetBlock.boundingBox();
await page.mouse.move(box.x + 3, box.y + 3);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3, { steps: 8 });
await page.mouse.up();
await page.waitForSelector("#selection-toolbar:not([hidden])", { timeout: 2000 });
await page.waitForTimeout(150);
await capture(page, 900);

// 10-11. Ask AI, show the real answer land in the sidebar
await page.click("#ask-ai-btn");
await page.waitForTimeout(150);
await capture(page, 700); // "Thinking…"
await page.waitForFunction(
  () => document.getElementById("ai-output").textContent.trim().length > 0,
  { timeout: 20000 }
);
await page.waitForTimeout(150);
await capture(page, 1600);

// Clear the lingering text selection/floating toolbar before switching sections.
await page.evaluate(() => window.getSelection().removeAllRanges());
await page.waitForTimeout(200);

// 12-14. Theme swatches
await page.click("#tab-settings-btn");
await page.waitForTimeout(150);
for (const theme of ["lavender", "sage", "sky"]) {
  await page.click(`.theme-swatch[data-theme="${theme}"]`);
  await page.waitForTimeout(200);
  await capture(page, 550);
}

// 15. Widen the sidebar
const handleBox = await page.$eval("#side-panel-resizer", (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(handleBox.x, handleBox.y);
await page.mouse.down();
await page.mouse.move(handleBox.x - 100, handleBox.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
await capture(page, 700);

await page.click("#tab-settings-btn"); // close panel

// 16. Export video modal
await page.click("#export-video-btn");
await page.waitForTimeout(200);
await capture(page, 1600);
await page.click("#export-cancel-btn");

await browser.close();

fs.writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Captured ${manifest.length} frames to ${OUT_DIR}. Now run: python3 scripts/make-gif.py`);
