# PDF Scroll Reader

A browser-only app that turns a document — PDF, Word (.docx), PowerPoint (.pptx), or plain text/Markdown — into a smooth scrolling "video-like" reading experience: auto-scroll playback, a real voice reading it back to you, highlight-to-AI explanations, AI summaries, freeform notes, and an export to an actual narrated video file for LinkedIn or any other platform.

Nothing is uploaded anywhere. Your document, your notes, and your API key all stay in this browser tab.

## Running it

No build step, no install (except for the optional test suite). Serve the folder over `http://` (module scripts and vendored assets won't load from a bare `file://` URL):

```sh
python3 -m http.server 8934
# or: npm run serve
```

Then open `http://localhost:8934/`.

## Features

- **Open PDF, DOCX, PPTX, TXT, MD, or HTML** — drag-and-drop or the "Open document" button.
- **Scrolling video mode** — Play/Pause auto-scrolls the document at an adjustable speed, with a seekable progress bar. Fully offline.
- **Read aloud** — uses the browser's built-in text-to-speech (Web Speech API), highlighting and auto-scrolling to the section currently being read. Choose the voice, rate, and pitch in Settings. Fully offline, free.
- **Highlight → Ask AI** — select any text to get a floating toolbar: ask Claude to explain the passage, add it straight to your notes, or have it read back to you.
- **Summarize** — current section or the whole document, via Claude (long documents are chunked and combined automatically).
- **Notes** — a free-text panel plus your saved AI answers/summaries, session-only by design (see below). Download as Markdown any time; closing the tab clears it for good.
- **Export video** — renders the whole document into a downloadable `.webm` video (square/vertical/landscape), with your live microphone narration, an optional title card, scroll-synced burned-in captions, and an optional quiet background music bed. Choose from three animation styles (smooth scroll, smooth scroll with a slow Ken Burns zoom, or slide-by-slide with crossfades — best for slide decks) and four visual themes (Classic, Midnight, Sunrise, Mono) that color the title card and caption bar. Scroll speed defaults to whatever you've currently set for on-screen reading. `.webm` is natively supported on LinkedIn and most social platforms.

## What's session-only vs. what needs the internet

| Feature | Needs internet? | Persists after closing the tab? |
|---|---|---|
| Opening/scrolling/reading documents | No | No (reopen the file next time) |
| Read Aloud (voice) | No | — |
| Notes | No | No — **download before closing** |
| Video export | No | No — **download the video before closing** |
| Ask AI / Summarize | Yes (calls Anthropic's API) | Your API key is kept in `sessionStorage` for convenience but is never written anywhere durable |

Your Anthropic API key is sent **only** to `api.anthropic.com`, directly from your browser, using Anthropic's documented direct-browser-access header. It is never sent to any other server. Because the key lives in browser memory, anyone with access to this browser tab/session could read it from DevTools — don't use this on a shared/public computer with a key you care about.

## Project layout

```
index.html            Shell + all UI markup
css/                   Styling (styles.css) + vendored pdf.js text-layer rules
js/
  app.js               Wires everything together
  loaders/             One loader per format → { title, kind, textBlocks }
  scrollPlayer.js       Auto-scroll "video" playback
  voiceReader.js        Web Speech API read-aloud + highlighting
  aiClient.js           Direct-from-browser Claude API calls
  notes.js              Session-only notes panel
  settings.js           API key / model / voice prefs (session-only)
  videoExport.js         Filmstrip build + canvas/MediaRecorder video export
vendor/                Vendored pdf.js, mammoth, JSZip, marked, html2canvas
                       (no CDN dependency — works fully offline once loaded)
test/smoke.mjs         Playwright smoke test (dev-only, not needed to use the app)
```

## Format support notes

- **PDF** — full-fidelity rendering via pdf.js: pages are drawn to canvas exactly as designed, so this is the one format immune by construction to any color/contrast issue below — nothing is restyled.
- **DOCX** — converted via mammoth.js into a continuous flowing article (no fixed "pages", since Word doesn't store pagination either). Mammoth's default conversion is semantic-only — it discards direct/manual formatting like font color and highlight fills, keeping structure (headings, lists, bold/italic) but not visual styling — so unlike HTML, there's no risk of e.g. white-on-white text from a document that used manual color formatting. Verified with a fixture containing an explicit white-on-black run.
- **PPTX** — a lightweight from-scratch reader (JSZip + XML parsing): extracts each slide's title, bullet text, and images into a clean "slide card". It only ever reads text content, never color/formatting — so it can't reproduce a slide's original color scheme, but it also can't render invisible text. It is **not** a pixel-perfect PowerPoint renderer — fonts, exact positions, and animations aren't reproduced, but the content is fully readable, narratable, and summarizable.
- **TXT** — split into paragraphs, no styling of any kind in the source to preserve or lose.
- **MD** — rendered via marked.js. Since marked passes any raw HTML embedded in the source straight through by default, it goes through the same sanitizer as `.html` uploads (see below) — both for security and for color-pairing correctness.
- **HTML** — parsed with DOMParser. `<script>`, event-handler attributes (`onclick` etc.), and `javascript:` URLs are stripped, since an uploaded HTML file is untrusted content even though it's local. Unlike a naive sanitizer, `<style>` tags are **not** discarded — most real HTML documents define their look (background/text color pairings especially) via CSS classes, and dropping the stylesheet while keeping the markup silently breaks that pairing (e.g. white text that depended on a dark box background goes invisible once the class defining that background is gone). Instead, styles are extracted and re-injected scoped via the CSS `@scope` at-rule to just that document's container, so the original page's own look is preserved without any risk of it leaking out and affecting the app's own UI.

## Video export notes

- Uses your microphone live while the scroll plays — read along at whatever pace you like; the scroll speed slider controls how fast it moves.
- Burned-in captions are synced to **scroll position**, not to speech-recognized words (there's no speech-to-text step) — so they track along with what's currently on screen, not word-for-word with your voice.
- Long documents produce long videos; there's no time limit, but very large documents (dozens of pages/slides) will take a while to rasterize before recording starts.

## Dev-only test suite

`test/smoke.mjs` drives the app with Playwright against a real (system) Chromium to catch regressions — file loading for all four formats, auto-scroll, voice reader state, notes/settings persistence, the highlight toolbar, and a full video export. It's not part of the app itself.

```sh
npm install       # installs playwright-core only
npm run serve     # in one terminal
npm test          # in another
```
