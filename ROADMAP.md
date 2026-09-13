# Roadmap

Ideas for what's next — not commitments, not scheduled. The in-app upgrade banner (shown 90 days after signup) points here.

## Buildable now (existing free Workers AI binding, no new infra)

### Contextual theme & pacing suggestion

Instead of a fixed theme dropdown, send the document's extracted text to Workers AI and get back a suggested export theme + reading speed that fits the content's tone — still overridable by the user, not forced. Cheapest of all these to build: reuses the exact `summarize`/`explain` request pattern already in `src/aiHandlers.js`.

### Auto-generated chapter markers

For longer documents, reuse the heading-detection logic already added for the video export's keyword pauses (`js/videoExport.js`'s `isKeywordBlock`) to produce a YouTube-style timestamped chapter list in the video description, or an in-app jump-to-section list. No AI call needed — pure document structure already being detected.

### Study companion: auto-quiz/flashcards

Generate 3-5 quick questions from the document via Workers AI, saveable to Notes. Turns passive reading into active studying — fits the app's "personal scrolling" positioning directly.

### Smart highlight reel

AI picks the most important few sentences and cuts a short 30-60s teaser video, separate from the full narrated one — built for sharing, pairs naturally with the video watermark's growth loop.

## Needs new infrastructure (bring-your-own-key, or storage/sharing)

### Bring-your-own-key natural voice narration

`js/voiceReader.js`'s Read Aloud uses the browser's built-in Web Speech API — free, offline, but voice quality is entirely OS-dependent (macOS/Windows sound reasonably natural; Linux's built-in voices tend to sound flat/robotic, and this varies from user to user with zero control from the app itself).

Idea: let a user paste their own API key for a real neural TTS service (ElevenLabs, OpenAI TTS, etc.) in Settings, and use that instead of `speechSynthesis` when present — same read-aloud UX (sentence highlighting, auto-scroll), meaningfully better voice quality, no cost to users who don't opt in. Falls back to the free browser voice for everyone else, so nothing regresses for people who don't want to bring a key.

### Multi-language subtitles/narration

AI-translate captions and generate SRT files alongside the video export. Captions-only could ship without any new infra; translated *narration* that sounds natural needs the bring-your-own-key TTS item above first.

### Shareable read-along link with comments

Publish a read-only version of a scroll session or export for others to comment on at specific timestamps. Needs real storage/sharing infrastructure beyond the D1 auth tables that exist today — the biggest lift on this list.
