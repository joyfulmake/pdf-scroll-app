# Architecture

This document is for anyone reviewing or extending the codebase — it covers how the pieces fit together and *why*, not just what each file does (the README covers user-facing features).

## System overview

```
┌─────────────────────────────── Browser (client-side app) ───────────────────────────────┐
│  index.html + js/*  — no build step, ES modules loaded directly                          │
│                                                                                            │
│  js/auth.js: AuthGate.requireSession() — app.js awaits this before anything else runs    │
│                                     │                                                      │
│  loaders/*.js  →  { title, kind, textBlocks }  →  scrollPlayer / voiceReader /            │
│  (one per format)     (a uniform contract          aiClient / videoExport                │
│                        every downstream feature     all consume this shape,               │
│                        depends on)                  regardless of source format)          │
└───────────────────────────────────┬───────────────────────────────────────────────────────┘
                                     │  GET  /api/auth/google/{start,callback}, /api/auth/me
                                     │  POST /api/auth/logout, /api/auth/dismiss-upgrade-banner
                                     │  POST /api/ai/{explain,summarize,combine}  (requireAuth-gated)
                                     ▼
┌────────────────────────────── Cloudflare Pages Functions ────────────────────────────────┐
│  functions/api/auth/*.js  →  src/authHandlers.js + src/authCookies.js  →  D1 (env.DB)     │
│  functions/api/ai/*.js    →  src/aiHandlers.js (requireAuth from authHandlers.js first)   │
│                                     │                                                      │
│                                     ▼                                                      │
│                          Workers AI binding (env.AI)                                       │
│                     @cf/meta/llama-3.3-70b-instruct-fp8-fast                                │
│                     free tier, no API key anywhere in this system                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Everything left of the network calls is a static, client-only SPA — no framework, no bundler, no build step. Everything right of them is Cloudflare-specific glue around a small number of shared handler modules, all served from one Pages project.

## Why there used to be two deployment targets

This app used to run on two Cloudflare deployment targets in parallel — worth understanding since the retired one's files (`src/worker.js`, `wrangler.jsonc`) are still in the repo, unused:

1. The project was first deployed via `wrangler pages deploy` (direct upload) — simplest path, no git integration needed.
2. Connecting the dashboard's "Connect to Git" flow for auto-deploy-on-push created a **Workers** project (deploy command `npx wrangler deploy`), not a classic Pages project — Cloudflare's newer unified model serves static assets from a Worker via an `assets` binding in `wrangler.jsonc`, with `main: src/worker.js` handling anything else (here, `/api/ai/*`).
3. Workers and Pages projects live in **separate name registries** in the same account, and Workers-issued `*.workers.dev` URLs always include an account-wide subdomain (`pdf-scroll-app.<account-subdomain>.workers.dev`) that can't be shortened per-project — whereas Pages projects get a clean `<project-name>.pages.dev` with no account-specific segment. A second, plain Pages project was added specifically to get that cleaner URL.
4. Since Pages doesn't read `wrangler.jsonc`'s `main`/`ai` fields the way Workers does, the AI proxy had to be reimplemented for Pages using its own convention — file-based routing under `functions/`. Rather than duplicate the prompts/model logic, both entry points imported the same `src/aiHandlers.js`. The AI binding itself is attached to the Pages project via the Cloudflare API (`PATCH .../pages/projects/{name}` with `deployment_configs.production.ai_bindings`) since there's no dashboard toggle or wrangler CLI flag for it at time of writing.

**Why it's down to one now**: adding Google sign-in meant wiring session cookies, D1, and OAuth secrets into whichever targets stay live — doable on both, but it roughly doubles every provisioning step and adds a real failure mode (one target's auth silently breaking while the other keeps working, worse than the old "one target is a version behind" drift). Since the Pages URL was always the one actually used, the Workers target is being retired rather than carried forward. `.assetsignore` keeps `src/`, `functions/`, and `wrangler.jsonc` out of the deployed *static assets* themselves — they're deployment inputs, not app files.

## Auth

Google OAuth, replicated from the same pattern already proven in a sibling project (`learning-strategist-app`), landed entirely as Pages Functions + two shared `src/` modules — no new runtime dependency, no JWT library:

- **`src/authHandlers.js`**: `buildGoogleAuthUrl`, `exchangeGoogleCode` (exchanges the code for tokens, then verifies the `id_token` via Google's own `GET /tokeninfo` endpoint — which validates the signature server-side and hands back verified claims — rather than implementing JWK-based JWT verification by hand), D1 user/session read/write functions, and `requireAuth(request, env)`, called explicitly at the top of every gated route (no middleware framework, same manual-dispatch style as the rest of this app's routing).
- **`src/authCookies.js`**: cookie parsing/writing (a short-lived CSRF `state` cookie during the OAuth redirect, the long-lived session cookie) and `sha256Hex`/`randomToken`.
- **Session** = an opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie, 90 days. Only its SHA-256 hash is stored in D1's `auth_sessions` table — the raw token never touches the database, so a DB leak alone can't be replayed as a live session.
- **`users.created_at`** (a `Date.now()` ms epoch, not a SQL timestamp) is the sole input to the 90-day upgrade-banner gate, computed server-side in `authUserPublicShape()` so the frontend never does its own date math and can't drift from the server's clock. `upgrade_banner_dismissed_at` lives on the same row (not the session), so a dismissal survives logout/login and follows the account across devices.
- **Client-side gate** (`js/auth.js`'s `AuthGate`): `app.js` does a top-level `await authGate.requireSession()` before instantiating any other feature. Unauthenticated, the promise never resolves on that page load — the overlay shows and nothing else ever wires up its listeners. The only way past it is the OAuth redirect round-trip, which reloads the page. This is a real barrier (no feature's event listeners exist to call) but not a server-enforced one — parsing/rendering has no server round-trip to gate at all, so a sufficiently determined user could bypass it via devtools. The one place gating is actually server-enforced is the AI endpoints (`functions/api/ai/*.js`, via `requireAuth`), since that's the only place real work/cost happens.
- **Test-only bypass**: `requireAuth` short-circuits to a fixed fake user if a request's `X-Test-Auth-Bypass` header matches `env.TEST_AUTH_BYPASS_SECRET` — driving a real Google login from Playwright isn't practical. That env var must only ever exist in a local `.dev.vars` (see `.dev.vars.example`), never as a real deployed Pages secret; if it's simply absent from `env` (the normal production case), the branch checking it can never be reached.

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

Two non-obvious constraints this module works around (see [Testing](#testing) point 3 for how the bugs from getting them wrong were actually found):

- `canvas.captureStream()` does not reliably emit frames purely from elapsed time — a canvas that is drawn once and then left alone (e.g. holding a static title card via a plain timer) produces little to no real video data even though wall-clock time genuinely passes. Every phase that needs to "hold" a frame for a duration (the title card, each slide's dwell) must actively redraw every frame in a loop, identical content or not — the repaint itself is what triggers frame capture.
- Never include an audio track from a `MediaStreamAudioDestinationNode` that nothing is actually connected to. It still reports as "live," but including it in the recorded stream corrupts the entire muxed output, not just the audio channel. The audio graph (and any audio track at all) is only created when a real source — mic and/or music — will actually feed it.

## Testing

`test/smoke.mjs` runs against either Chromium or Firefox (`BROWSER=firefox`, using Playwright's own patched Firefox build — vanilla system Firefox doesn't speak Playwright's automation protocol), and against either the local static file server or a live deployed URL — the same script, parameterized by `BASE_URL`. AI-dependent checks (`Ask AI`, `Summarize`) detect a local run and skip gracefully, since `/api/ai/*` only exists on the actual Cloudflare deployment; run against a live URL, they exercise the real Workers AI model, not a mock.

Three bug classes were caught specifically *by* the test suite's design (or by testing on a second real engine), worth noting since they'd be easy to reintroduce:

1. **Checking the `hidden` *attribute* isn't the same as checking actual visibility.** Several components set their own `display` (flex/grid) unconditionally, which — being equal CSS specificity to the UA's `[hidden]{display:none}` and loading later — silently won, rendering elements that had `hidden` set. Early tests asserted on `el.hidden` (the IDL property, which only reflects attribute presence), so this went undetected through multiple redesigns until a visual screenshot review caught panels stacking on top of each other. Fixed with one global `[hidden]{display:none!important}` rule instead of patching each component, and tests now assert `getComputedStyle(el).display !== "none" && el.offsetParent !== null`.
2. **Checking DOM presence isn't the same as checking rendered contrast.** The dark-mode theme surfaced a pre-existing bug (document content background followed the app theme while its text color was hardcoded dark) that no test caught because none checked computed color values. Regression tests now compute relative luminance of both background and text color for document content across every theme.
3. **Checking `blob.src.startsWith("blob:")` isn't the same as checking the blob is a real, playable file.** The video export tests all passed for a long time while every export they produced was actually a broken, ~110-byte, unplayable container — because including an audio track from an *unconnected* `MediaStreamAudioDestinationNode` (exactly what "mic off, no music" produces) corrupts the entire muxed output, and nothing ever checked file size or fed it through an actual video parser. Caught by manually saving a real export and opening it with OpenCV/ffmpeg outside the browser entirely — the kind of check no in-browser assertion would surface. Fixed by only attaching an audio track when a real source is connected, and tests now assert a realistic minimum byte size. Testing on a second real engine (Firefox, via Playwright's own build) surfaced a further, unrelated bug in the same area: an explicit `"video/webm;codecs=vp8,opus"` mimeType caused `MediaRecorder.stop()` to transition state to `"inactive"` but never fire `onstop`/`ondataavailable` — a silent hang, no exception, `isTypeSupported()` reporting it as fine. Removed that exact candidate in favor of bare `"video/webm"`, which lets the browser pick its own codec.

The general lesson embedded in the suite going forward: prefer assertions on real, external verification (computed styles, actual file bytes, a second engine) over "it didn't throw" or attribute/DOM-shape checks, wherever a deeper regression is plausible.

## Known limitations

- PPTX rendering is a from-scratch reader, not a PowerPoint-fidelity renderer — fonts, positions, animations, and original color schemes aren't reproduced (see [Security / sanitization decisions](#security--sanitization-decisions) for why that's also what keeps it safe from a specific bug class).
- Video export captions are synced to scroll position, not to recognized speech — there's no speech-to-text step, so they track what's on screen, not word-for-word with a live mic narration.
- The two deployment targets require re-running `wrangler pages deploy` manually for the Pages project after each change; only the Workers project auto-deploys on push.
