# B-Side

A music generator and player for [Crucible](https://github.com/telltaleatheist/crucible):
write the style and lyrics, generate songs (or instrumentals) with YuE2 (`yue2-3b`) on a
Crucible server, and listen to them in a queue while more generate. Every song is saved to
a local library, so it is still there tomorrow. Album-minded: cover art next.

Private. Electron 33 + Angular 21, built and themed after Foundry's app.

## Run it

```bash
npm install
npm run electron:dev     # ng serve on port 4270 + Electron --dev
```

Then open **Settings**, paste a Crucible pairing line
(`crucible://<name>@<host>:<port>/#<token>`), or enter an address and token by hand, and
press **Test connection**.

Other scripts: `npm run typecheck`, `npm run build` (main process to `dist/electron`,
renderer to `dist/renderer`), `npm run electron:prod` (build, then run the built app),
`npm test` (bun).

## What it does

- **Style tags as chips.** Type a phrase and a comma or Enter to add it; paste a comma list
  to split it; Backspace on an empty box removes the last. Suggestions by group, click to
  add or remove. **Copy** puts the chips on the clipboard as one comma-separated line.
- **Conflicts in red**, with what each tag conflicts with and why in its tooltip. The
  suggestions and the conflict map are the server's (`GET /v1/playground`, the `yue2-3b`
  page's `tags` field); B-Side keeps no copy.
- **Lyrics** with `[Verse]` / `[Chorus]` sections, and an **Instrumental** switch that turns
  the lyrics off and sends `instrumental: true`. The server's refusals
  (`audio_param_conflict`, `audio_param_missing`, ...) show on the job's row as they come.
- **Guidance (cfg)**, **seed** (blank = random) and **Generate N in a row** (1-20; with a seed,
  the jobs get seed, seed+1, ...).
- **Presets** kept on the server (`/v1/playground/presets/yue2-3b`): load, save, delete.
  Never the seed.
- **Jobs** followed in the main process through `@crucible/client`: queued position,
  progress, done/failed/cancelled/removed; a `409 installing` is followed through the
  install task and the job is sent again. Each job can be cancelled. Jobs still generating
  when B-Side quits are followed again on the next launch.
- **Queue** on the right, oldest first (play order). **Player** along the bottom: previous
  (restarts after 3 s), play/pause, next, scrubber. The first finished song plays when the
  player is idle; at the end of a song it moves on, or waits for the next to land.
- **Library**: each song is `<Music>/B-Side/<id>.flac` plus `<id>.json` (title, tags, lyrics,
  instrumental, cfg, seed, server, Crucible job id, created time, duration, batch place,
  and the server's own effective params). Rename and delete from the queue.

## Layout

```
electron/   main process: window, IPC, Crucible calls, job runner, library, servers
  crucible.ts      SDK client + the playground routes (song page, presets)
  jobs.ts          submit / install / follow / land, pending.json for restarts
  library.ts       songs on disk (audio + sidecar)
  servers.ts       <userData>/servers.json (tokens stay in main)
  song-protocol.ts bside-song:// with range requests, for the player
shared/     types and pure logic compiled by both programs (tags, batch seeds, the bridge API)
src/        Angular renderer: studio (form + queue), settings, player bar
test/       bun tests: tags/conflicts, batch seeds, server registry + pairing, library
vendor/     @crucible/client tarball from the Crucible GitHub release
```

## Later

Albums and cover art: every sidecar carries `album: null` and `Song.album` exists in
`shared/types.ts` as the seam; nothing reads it yet.
