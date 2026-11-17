# Lectoria

A reader for books and documents with neural voices. [Kavita](https://www.kavitareader.com) and a server-side voice engine are both **optional**: a sensor detects what is configured and answering, and the interface shows only what works. Listen to your library, blog articles and your own texts; generate full audiobooks in the background.

## Features

- **Sources:** Kavita libraries (EPUB, PDF, DOCX, HTML, TXT), public Blogger feeds, uploaded files and pasted text. Imported items can be refreshed from their origin, and an automatic sync keeps them up to date.
- **Neural voices:** text-to-speech through a local voice engine (Piper, Kokoro, Sopro and others), with per-language preferred voices, speed control and word highlighting. A browser engine (Kokoro and Piper via WASM) can run on the device itself, or mixed with the server.
- **Full audio jobs:** a queue turns a whole book into an MP3 with ID3 tags and cover art, scheduled now or at night, with accurate ETAs, a CPU and temperature governor, and live listening always taking priority.
- **Reading experience:** per-passage cache on disk (so playback starts instantly after the first pass), pre-buffering ahead and behind, chapters and table of contents, sleep timer, queue and playlists, bookmarks and notes.
- **Shared progress:** reading position and bookmarks are stored in Kavita, so they follow you across devices.
- **Word export:** annotations and bookmarks can be exported to Word.
- **Installable PWA:** responsive layouts for desktop, tablet and phone; keeps playing with the screen off.
- **Login with your Kavita account** when Kavita is connected (no separate user database); otherwise a single local user.

## Requirements

- Node.js 22 or newer (no runtime dependencies).
- Python 3 with `pdftotext` (poppler) for text extraction; `mutagen` and `soundfile` for MP3 export.
- Optional: a running [Kavita](https://www.kavitareader.com) server (library, shared progress, login).
- Optional: a voice engine exposing `/api/voice` (the one used here is [BlogArtifex](https://github.com/hubertdungen/blogartifex)). Without it the voices run in the browser.
- Optional: public Blogger blogs to import from (`LECTORIA_BLOGS`).

## Run

```bash
git clone https://github.com/hubertdungen/Lectoria.git
cd Lectoria
npm ci
# Standalone: no Kavita, no BlogArtifex, browser voices
HOST=127.0.0.1 LECTORIA_KAVITA_URL= LECTORIA_VOICE_URL= npm start
```

Open http://127.0.0.1:8104. Browser voices download their models on first use and require internet access.

To use **both integrations**, run your Kavita and BlogArtifex voice bridge first, then:

```bash
cp .env.example .env
# Edit .env: set the two service URLs and the path to your voice bridge key.
set -a
. ./.env
set +a
npm start
```

The app does not load `.env` automatically. Set either service URL to an empty value to disable just that integration. The bridge key stays outside Git.

Configuration is by environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `8104`, `0.0.0.0` | Listen address |
| `LECTORIA_DATA` | `./data` | Users, sessions, jobs, stats |
| `LECTORIA_KAVITA_URL` | `http://127.0.0.1:5000` | Kavita server; **empty = off** |
| `LECTORIA_VOICE_URL` | `http://127.0.0.1:8103` | Voice engine; **empty = off** |
| `LECTORIA_VOICE_KEY_FILE` | `<data>/voice-bridge.key` | Shared key for the voice engine |
| `LECTORIA_BLOGS` | empty | Comma-separated Blogger URLs; empty = no Blogs section |
| `LECTORIA_CACHE_DIR`, `LECTORIA_CACHE_MAX_MB` | `<data>/cache`, `6000` | Passage cache |
| `LECTORIA_CLOUD_DIR` | empty | Optional folder where finished MP3s are copied |
| `LECTORIA_EXPORT_DIR` | empty | Optional folder for Word exports |
| `LECTORIA_GOVERNOR` | on | `0` disables the CPU/temperature governor |

## Optional integrations

`GET /api/capabilities` (public) reports what is configured and what answers right now (1.5 s probe, cached 30 s; 10 s after a failure). The page reads it at start and hides what is missing.

| Kavita | Voice engine | Result |
| --- | --- | --- |
| off | off | Single local user, no sign-in. Uploads, pasted text and blogs (if set); voices run in the browser (Tugão, Kokoro). The Kavita, Blogs (when unset) and Audios views are hidden. |
| off | on | As above, with the server voices, the passage cache and full audio jobs. |
| on | off | Kavita login and library; browser voices; no full audio jobs. |
| on | on | Everything. |
| configured but down | | Marked "indisponível de momento" in the menu; you are never signed in as a local user as a way around Kavita's login. |

To connect one later, set its variable (see `.env.example`) and restart; nothing else changes. A Kavita-less instance has no passwords, so keep it on `HOST=127.0.0.1` or behind your own access control.

## Tests

```bash
npm test             # node:test and unittest, with Kavita and the voice engine mocked
```

## Licence

Copyright (c) 2026 Hubert Dungen. Lectoria is a DL Forge project, a DungenLabs sub-brand. Licensed under GPL-3.0-only, see [LICENSE](LICENSE). Portuguese readme: [README.pt-PT.md](README.pt-PT.md).

## Language

The interface is in European Portuguese.

<p align="center"><a href="https://dlforge.dungenlabs.com"><picture><source media="(prefers-color-scheme: dark)" srcset="branding/dlforge-logo-negative.svg"><img src="branding/dlforge-logo.svg" alt="DL Forge" width="120"></picture></a></p>
