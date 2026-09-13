# Roadmap

Ideas for what's next — not commitments, not scheduled. The in-app upgrade banner (shown 90 days after signup) points here.

## Bring-your-own-key natural voice narration

`js/voiceReader.js`'s Read Aloud uses the browser's built-in Web Speech API — free, offline, but voice quality is entirely OS-dependent (macOS/Windows sound reasonably natural; Linux's built-in voices tend to sound flat/robotic, and this varies from user to user with zero control from the app itself).

Idea: let a user paste their own API key for a real neural TTS service (ElevenLabs, OpenAI TTS, etc.) in Settings, and use that instead of `speechSynthesis` when present — same read-aloud UX (sentence highlighting, auto-scroll), meaningfully better voice quality, no cost to users who don't opt in. Falls back to the free browser voice for everyone else, so nothing regresses for people who don't want to bring a key.
