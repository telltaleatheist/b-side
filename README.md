# B-Side

A music generator and player for [Crucible](https://github.com/telltaleatheist/crucible):
describe the music or pick style tags, write lyrics (or make an instrumental), generate
songs with YuE2 (`yue2-3b`) on a Crucible server, and listen to them in a playing list
while more generate. Keep the ones you like in named playlists. Album-minded: cover art
next.

One computer is the **hub**: the desktop app. It talks to Crucible, keeps the library, and
serves the same app to a browser on your network and to the iPhone app. Private. Electron 33 +
Angular 21, built and themed after Foundry's app.

## Run it

```bash
npm install
npm run electron:dev     # ng serve on port 4270 + Electron --dev (the hub listens on 7300)
```

With no Crucible server yet, the studio offers the one thing this computer needs:
**Install Crucible** (it installs, starts and connects Crucible, with its progress as it
goes, and never shows a command), **Start Crucible** when it is installed and stopped, or
**Use the Crucible on this computer** when it is running. Or paste an existing server's
pairing line (`crucible://<name>@<host>:<port>/#<token>`) there or in **Settings**, or
enter an address and token by hand, and press **Test connection**. Installing (and
removing) Crucible is done only from the desktop app, never from a phone or browser tab.

**Other devices:** Settings → *Other devices* → *Share on my network*. Open one of the links
it shows (`http://<this computer>:7300/#key=...`) in a browser on a phone or another
computer, or paste it into the iPhone app.

**iPhone:** on the Mac, with the phone plugged in and unlocked:

```bash
cd mobile && npm install && npm run package:ios   # builds the web app, syncs, signs, installs
```

Other scripts: `npm run typecheck`, `npm run build` (main to `dist/electron`, the app to
`dist/renderer`), `npm run electron:prod`, `npm test` (bun).

## What it does

- **Describe the music** ("in the style of the DOS game One Must Fall 2097", "smooth lo-fi
  with jazz sax") and a small model on the server (`qwen3.5-4b`) fills in the style tags.
- **Style tags as chips**, the server's suggestions by group, **conflicts in red** with why.
  **Copy** puts them on the clipboard. The vocabulary and conflict map are the server's
  (`GET /v1/playground`); B-Side keeps no copy.
- **Lyrics** with `[Verse]` / `[Chorus]` sections, an **Instrumental** switch, **guidance
  (cfg)**, **seed** (blank = random), **Generate N in a row** (with a seed: seed, seed+1, ...).
- **Presets** kept on the server, never the seed.
- **Jobs** followed by the hub through `@crucible/client`: queue position, progress, a first-use
  install followed and the job sent again, cancel. Jobs still generating when B-Side quits
  are followed again on the next launch.
- **The playing list**: what each device generated, oldest first, playing in turn; the next
  song plays the moment it lands. Nothing here is kept for long — the hub clears the oldest
  first (desktop 200 songs, phone 60, browser tab 40, 4 GB in all), and a browser tab's list
  goes a few minutes after the tab closes.
- **Playlists**: **Save** a song from the playing list into a named playlist; that is the
  only way a song is kept. Play, reorder, rename, delete. A song lives while some playlist
  holds it. Saved songs are `<library>/<id>.flac` + `<id>.json` (tags, lyrics, seed, server,
  Crucible job, and the server's own effective params), playlists in `playlists.json`.
- **On the iPhone**: a native player (it keeps playing, and moves to the next song, with the
  screen locked; lock-screen controls), and **Keep on this phone** for playlists you want
  offline.

## Layout

```
electron/        main process
  hub/           the hub: HTTP server (app + /api + SSE), clients, http helpers
  crucible.ts    the SDK client: song page, presets, info
  describe.ts    describe the music -> tags (chat with a JSON schema)
  jobs.ts        submit / install / follow / land, pending.json for restarts
  takes.ts       the take cache: every device's playing list, FIFO
  library.ts     saved songs and playlists.json
  servers.ts     <userData>/servers.json (Crucible tokens never leave main)
  ipc.ts         the desktop-only bridge: the hub's address, folder and save dialogs,
                 and the Crucible on this computer
  crucible-install*.ts, crucible-local.ts, crucible-uninstall.ts
                 install / start / use / remove Crucible here (@crucible/bootstrap)
shared/          types and pure logic compiled by both programs
src/             the Angular app every device runs (HubService: one HTTP + SSE transport)
mobile/          the iPhone app: Capacitor wrapper, native queue player and file store
test/            bun tests, the hub over real HTTP included
vendor/          @crucible/client and @crucible/bootstrap tarballs from the Crucible release
docs/PLAN.md     the plan, what is done and what is verified
```

## Later

Albums and cover art: every sidecar carries `album: null` and `Song.album` exists in
`shared/types.ts` as the seam; nothing reads it yet.
