# Architecture

This document is for anyone reviewing or extending the codebase — it covers how the pieces fit together and *why*, not just what each file does (the README covers user-facing features).

## System overview

```
┌─────────────────────────────── Browser (client-side app) ───────────────────────────────┐
│  index.html + js/*  — no build step, ES modules loaded directly                          │
│                                                                                            │
│  loaders/*.js  →  { title, kind, textBlocks }  →  scrollPlayer / voiceReader /            │
│  (one per format)     (a uniform contract          aiClient / videoExport                │
│                        every downstream feature     all consume this shape,               │
│                        depends on)                  regardless of source format)          │
└───────────────────────────────────┬───────────────────────────────────────────────────────┘
                                     │  POST /api/ai/{explain,summarize,combine}
                                     ▼
┌──────────────────────── Cloudflare (server-side, two parallel targets) ──────────────────┐
│  src/worker.js (Workers)          OR         functions/api/ai/*.js (Pages Functions)      │
│  both import the same src/aiHandlers.js — identical prompts/logic either way              │
│                                     │                                                      │
│                                     ▼                                                      │
│                          Workers AI binding (env.AI)                                       │
│                     @cf/meta/llama-3.3-70b-instruct-fp8-fast                                │
│                     free tier, no API key anywhere in this system                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Everything left of the network call is a static, client-only SPA — no framework, no bundler, no build step. Everything right of it is ~120 lines of Cloudflare-specific glue around one shared handler module.

## Why two deployment targets

This wasn't planned up front — it's the result of how Cloudflare's dashboard flows actually behave, worth understanding before touching either config:

1. The project was first deployed via `wrangler pages deploy` (direct upload) — simplest path, no git integration needed.
2. Connecting the dashboard's "Connect to Git" flow for auto-deploy-on-push created a **Workers** project (deploy command `npx wrangler deploy`), not a classic Pages project — Cloudflare's newer unified model serves static assets from a Worker via an `assets` binding in `wrangler.jsonc`, with `main: src/worker.js` handling anything else (here, `/api/ai/*`).
3. Workers and Pages projects live in **separate name registries** in the same account, and Workers-issued `*.workers.dev` URLs always include an account-wide subdomain (`pdf-scroll-app.<account-subdomain>.workers.dev`) that can't be shortened per-project — whereas Pages projects get a clean `<project-name>.pages.dev` with no account-specific segment. A second, plain Pages project was added specifically to get that cleaner URL.
4. Since Pages doesn't read `wrangler.jsonc`'s `main`/`ai` fields the way Workers does, the AI proxy had to be reimplemented for Pages using its own convention — file-based routing under `functions/`. Rather than duplicate the prompts/model logic, both entry points import the same `src/aiHandlers.js`, so a change to one always applies to both. The AI binding itself is attached to the Pages project via the Cloudflare API (`PATCH .../pages/projects/{name}` with `deployment_configs.production.ai_bindings`) since there's no dashboard toggle or wrangler CLI flag for it at time of writing.

Net effect: two URLs, functionally identical, both auto-verified by the same test suite before anything ships (see [Testing](#testing) below). `.assetsignore` keeps `src/`, `functions/`, and `wrangler.jsonc` out of the deployed *static assets* themselves — they're deployment inputs, not app files.

## The loader contract

Every format loader (`js/loaders/*.js`) returns the same shape:

```js
{ title: string, kind: string, textBlocks: [{ el: HTMLElement, text: string, label: string|null }] }
```

`textBlocks` is the load-bearing abstraction: it's what makes voice reading, AI summarization, video export segmentation, and highlight-to-AI context lookup all format-agnostic. Its granularity is deliberately format-appropriate rather than uniform:

- **PDF/PPTX** naturally paginate — one block per page/slide (`el` *is* the page/slide container).
- **DOCX/TXT/HTML/MD** render as one continuous flowing element (Word/Markdown/HTML don't carry fixed pagination), so `textBlocks` is one entry per paragraph/heading *within* that single container.

This distinction mattered concretely: the video export's slide-by-slide mode and its scroll-mode captions both key off `textBlocks` positions. An earlier version treated the top-level rendered element as the unit for both filmstrip construction *and* captions/slide-breaks — correct for PDF/PPTX, but for DOCX/TXT it meant the *entire document* was one "slide" (squeezed into a single frame) and captions never changed for the whole video. Fixed by computing caption/slide-break segments from `textBlocks` (paragraph-level for DOCX/TXT) while filmstrip *image* construction still stacks whole top-level elements (one rasterization pass per page, not per paragraph — that part was already correct and unrelated to the bug).

## Security / sanitization decisions

Two of the four upload formats accept content this app doesn't control the structure of: `.html` directly, and `.md` indirectly (marked.js passes any raw HTML embedded in Markdown straight through by default — that path had **zero** sanitization until it was noticed and fixed to reuse the same sanitizer as `.html`).

`js/loaders/sanitizeHtml.js` is intentionally *not* a naive strip-everything sanitizer:

- `<script>` tags, `on*` event-handler attributes, and `javascript:` URLs are removed — the actual code-execution vectors.
- `<style>` tags are **preserved**, not discarded. A first version stripped them along with scripts, which silently broke a large class of real-world documents: most non-trivial HTML defines its look via CSS classes, so removing the stylesheet while keeping the markup can leave e.g. white text with no matching dark background to sit on, going invisible against this app's own default background. Instead, style content is extracted, has its top-level `html`/`body`/`:root` selectors remapped to `:scope` (the common way a page sets an overall background/text color), and is re-injected wrapped in `@scope(#container-id) { ... }` — scoped so it can only affect that one loaded document, never leak out and affect the app's own UI chrome.
- Verified with a fixture reproducing the actual reported failure (a dark-box-with-white-text layout driven by a `<style>` class rule) rather than a synthetic "does sanitize() run" check.

DOCX and PPTX were checked empirically rather than assumed safe: a DOCX fixture with an explicit white-on-black run confirms mammoth.js's default conversion discards manual/direct formatting (semantic-only: headings, lists, bold/italic survive; color and highlight fills don't), and the PPTX parser's source was read to confirm it only ever extracts `<a:t>` text content, never `<a:solidFill>`/color properties — so it structurally cannot reproduce this bug, at the cost of not reproducing original slide styling at all (a documented, deliberate fidelity trade-off, not a bug).

PDF is immune by construction — pdf.js renders pages to `<canvas>` pixel-for-pixel; nothing about a PDF page is restyled by this app's CSS.

## Video export

`js/videoExport.js` builds one tall offscreen "filmstrip" canvas per document (PDF pages reused directly from their already-rendered canvases; DOCX/PPTX/TXT/HTML pages rasterized once via html2canvas), then drives one of three playback scripts against it while `MediaRecorder` captures the export canvas, mixed with a live microphone track (and optional background music) via a Web Audio `MediaStreamDestination`:

- **Smooth scroll** — continuous `drawImage` window sliding down the filmstrip at the configured px/s.
- **Smooth scroll + zoom** — same, plus a slowly shrinking source-crop window for a Ken Burns effect.
- **Slide-by-slide** — atomic `textBlocks` segments are grouped into screen-sized chunks (capped at one page each, so a group never straddles two different rasterized page canvases), each held for a narration-paced duration estimated from its text length, with a cross-fade between groups.

Browser TTS (used for the live in-app "Read Aloud" feature) **cannot** be captured into a `MediaRecorder` stream — there's no accessible audio node for it in any mainstream browser. That's why video narration is a live microphone take rather than automated TTS baked into the export; this is a hard platform constraint, not a missed feature.

## Testing

`test/smoke.mjs` runs a real (system) Chromium via `playwright-core` against either the local static file server or a live deployed URL — the same script, parameterized by `BASE_URL`. AI-dependent checks (`Ask AI`, `Summarize`) detect a local run and skip gracefully, since `/api/ai/*` only exists on the actual Cloudflare deployment; run against a live URL, they exercise the real Workers AI model, not a mock.

Two bug classes were caught specifically *by* the test suite's design, worth noting since they'd be easy to reintroduce:

1. **Checking the `hidden` *attribute* isn't the same as checking actual visibility.** Several components set their own `display` (flex/grid) unconditionally, which — being equal CSS specificity to the UA's `[hidden]{display:none}` and loading later — silently won, rendering elements that had `hidden` set. Early tests asserted on `el.hidden` (the IDL property, which only reflects attribute presence), so this went undetected through multiple redesigns until a visual screenshot review caught panels stacking on top of each other. Fixed with one global `[hidden]{display:none!important}` rule instead of patching each component, and tests now assert `getComputedStyle(el).display !== "none" && el.offsetParent !== null`.
2. **Checking DOM presence isn't the same as checking rendered contrast.** The dark-mode theme surfaced a pre-existing bug (document content background followed the app theme while its text color was hardcoded dark) that no test caught because none checked computed color values. Regression tests now compute relative luminance of both background and text color for document content across every theme.

The general lesson embedded in the suite going forward: prefer assertions on `getComputedStyle`/actual rendered output over attribute or DOM-shape checks, wherever a CSS regression is plausible.

## Known limitations

- PPTX rendering is a from-scratch reader, not a PowerPoint-fidelity renderer — fonts, positions, animations, and original color schemes aren't reproduced (see [Security / sanitization decisions](#security--sanitization-decisions) for why that's also what keeps it safe from a specific bug class).
- Video export captions are synced to scroll position, not to recognized speech — there's no speech-to-text step, so they track what's on screen, not word-for-word with a live mic narration.
- The two deployment targets require re-running `wrangler pages deploy` manually for the Pages project after each change; only the Workers project auto-deploys on push.
