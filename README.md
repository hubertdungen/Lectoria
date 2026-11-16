# Lectoria

A reader for books and documents with local neural voices and [Kavita](https://www.kavitareader.com) integration. Listen to your library, blog articles and your own texts; generate full audiobooks in the background.

## Features

- **Sources:** Kavita libraries (EPUB, PDF, DOCX, HTML, TXT), public Blogger feeds, uploaded files and pasted text. Imported items can be refreshed from their origin, and an automatic sync keeps them up to date.
- **Neural voices:** text-to-speech through a local voice engine (Piper, Kokoro, Sopro and others), with per-language preferred voices, speed control and word highlighting. A browser engine (Kokoro and Piper via WASM) can run on the device itself, or mixed with the server.
- **Full audio jobs:** a queue turns a whole book into an MP3 with ID3 tags and cover art, scheduled now or at night, with accurate ETAs, a CPU and temperature governor, and live listening always taking priority.
- **Reading experience:** per-passage cache on disk (so playback starts instantly after the first pass), pre-buffering ahead and behind, chapters and table of contents, sleep timer, queue and playlists, bookmarks and notes.
- **Shared progress:** reading position and bookmarks are stored in Kavita, so they follow you across devices.
- **Word export:** annotations and bookmarks can be exported to Word.
- **Installable PWA:** responsive layouts for desktop, tablet and phone; keeps playing with the screen off.
- **Login with your Kavita account.** No separate user database.

## Requirements

- Node.js 22 or newer (no runtime dependencies).
- Python 3 with `pdftotext` (poppler) for text extraction; `mutagen` and `soundfile` for MP3 export.
- A running Kavita server.
- A voice engine exposing `/api/voice` (the one used here is [BlogArtifex](https://github.com/hubertdungen/blogartifex)).

## Run

```bash
npm start            # listens on port 8104
```

Configuration is by environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `8104`, `0.0.0.0` | Listen address |
| `LECTORIA_DATA` | `./data` | Users, sessions, jobs, stats |
| `LECTORIA_KAVITA_URL` | `http://127.0.0.1:5000` | Kavita server |
| `LECTORIA_VOICE_URL` | `http://127.0.0.1:8103` | Voice engine |
| `LECTORIA_VOICE_KEY_FILE` | `<data>/voice-bridge.key` | Shared key for the voice engine |
| `LECTORIA_BLOGS` | two example blogs | Comma-separated Blogger URLs, empty to disable |
| `LECTORIA_CACHE_DIR`, `LECTORIA_CACHE_MAX_MB` | `<data>/cache`, `6000` | Passage cache |
| `LECTORIA_CLOUD_DIR` | empty | Optional folder where finished MP3s are copied |
| `LECTORIA_EXPORT_DIR` | empty | Optional folder for Word exports |
| `LECTORIA_GOVERNOR` | on | `0` disables the CPU/temperature governor |

## Tests

```bash
npm test             # node:test and unittest, with Kavita and the voice engine mocked
```

## Language

The interface is in European Portuguese.

<p align="center"><a href="https://dlforge.dungenlabs.com"><picture><source media="(prefers-color-scheme: dark)" srcset="branding/dlforge-logo-negative.svg"><source media="(prefers-color-scheme: light)" srcset="branding/dlforge-logo.svg"><img src="branding/dlforge-logo.svg" alt="DL Forge" width="120"></picture></a></p>
