# Roadmap

Ideas for what's next — not commitments, not scheduled. The in-app upgrade banner (shown 90 days after signup) points here.

## Shipped

### Contextual theme & pacing suggestion ✅

The export modal's theme field has a "✨ Suggest" button — sends the document's text to Workers AI (`src/aiHandlers.js`'s `suggestTheme`), applies the suggested theme + reading speed directly, still fully overridable afterward.

### Auto-generated chapter markers ✅

Scroll and slide-by-slide exports now show a timestamped chapter list (`MM:SS  Heading`) after rendering, computed analytically from the same heading-detection and speed model the export animation itself uses (`js/videoExport.js`) — no AI call needed. Copyable, e.g. for a YouTube description.

### Study companion: auto-quiz/flashcards ✅

"🧠 Quiz me" in the Notes/AI panel generates 5 short Q/A pairs via Workers AI (`src/aiHandlers.js`'s `quiz`), through the same output/save/read-back pipeline every other AI result already uses.

### Smart highlight reel ✅

"Highlight reel (AI-picked, ~20-30s)" is a 4th export animation mode — Workers AI picks 4-6 key sentences (`pickHighlights`), matched back to the document's own rendered pages and played through the existing slide-crossfade pipeline.

## Needs new infrastructure (bring-your-own-key, or storage/sharing)

### Bring-your-own-key natural voice narration

`js/voiceReader.js`'s Read Aloud uses the browser's built-in Web Speech API — free, offline, but voice quality is entirely OS-dependent (macOS/Windows sound reasonably natural; Linux's built-in voices tend to sound flat/robotic, and this varies from user to user with zero control from the app itself).

Idea: let a user paste their own API key for a real neural TTS service (ElevenLabs, OpenAI TTS, etc.) in Settings, and use that instead of `speechSynthesis` when present — same read-aloud UX (sentence highlighting, auto-scroll), meaningfully better voice quality, no cost to users who don't opt in. Falls back to the free browser voice for everyone else, so nothing regresses for people who don't want to bring a key.

### Multi-language subtitles/narration

AI-translate captions and generate SRT files alongside the video export. Captions-only could ship without any new infra; translated *narration* that sounds natural needs the bring-your-own-key TTS item above first.

### Shareable read-along link with comments

Publish a read-only version of a scroll session or export for others to comment on at specific timestamps. Needs real storage/sharing infrastructure beyond the D1 auth tables that exist today — the biggest lift on this list.
