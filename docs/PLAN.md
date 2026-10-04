# B-Side plan

Owen's direction, 2026-10-04. Work through these in order; tick each box when it is done
and verified (not when the code is written). Much of this is already solved in Foundry and
BookForge/Bookshelf - find it there and reuse the idea before inventing anything.

## The architecture (decided)

- **The desktop app is the hub**, exactly like BookForge is for Bookshelf. It runs on one
  computer (whatever it is installed on - B-Side is meant for other people too, so nothing
  may assume Owen's machines, titan, or his tailnet).
- **Crucible generates; clients download and play.** The hub talks to Crucible (the only
  holder of the Crucible token). Web and iOS never talk to Crucible directly.
- **Two kinds of list:**
  - the **playing list** (the running queue of generated songs): ephemeral everywhere;
  - **playlists**: created and named by the user. Only songs saved to a playlist are kept
    long term, and they live in the desktop's dedicated **library folder**.
- **Web** is served by the desktop app. A browser cannot keep anything long term: its
  playing list starts clearing FIFO when the browser closes or long before memory gets
  tight (e.g. 8 hours of generating) - set a budget well under any limit.
- **iOS** (Capacitor) streams from the running desktop hub, and can save songs for offline
  listening. Its playing list also clears FIFO well before it becomes a problem.
- **Same UI everywhere**: the Angular app with a transport layer (Electron IPC on desktop,
  HTTP to the hub on web/iOS).
- **Setup**: the Electron setup page can install Crucible on this computer (Foundry and
  BookForge already do this through `@crucible/bootstrap`) or add an existing Crucible
  server. iOS and web pick or add a B-Side hub.

## Lessons to carry from Bookshelf iOS (Owen: "worth it to copy the general idea")

- Use iOS-specific audio adapters so playback works with the iOS audio system
  (background audio, lock screen, interruptions). The `<audio>` element must be in the DOM
  on iOS (BookForge memory: ios-audio-element-must-be-in-dom).
- Do NOT hit the server nonstop - the Bookshelf iOS app "lit the phone on fire" with heat.
  Follow events (SSE) with backoff instead of polling, stop work when backgrounded, batch
  requests.
- Talk to the hub safely the way Bookshelf does (pairing/token, LAN or tailnet address).

## Tasks

### Phase 0 - review v1
- [ ] Review the v1 built 2026-10-04 (all of `electron/`, `src/`, `shared/`): correctness,
      no fallbacks/band-aids, matches Foundry's patterns.
- [ ] Prove the receive side (done event -> artifact -> library) with ONE real render.
      Owen gave the GPU go for B-Side test renders on 2026-10-04 ("GPU is yours").

### Phase 1 - playing list vs playlists
- [ ] Split the model: the playing list (ephemeral session queue) vs named playlists.
      Generated songs land in the playing list; only "Save to playlist" copies a song into
      the library folder.
- [ ] Playlist CRUD (create, rename, delete, add/remove/reorder songs) and a playlists view
      to play a saved playlist.
- [ ] Desktop playing list: decide its own retention (temp folder, FIFO cap) - songs not
      saved are temporary on desktop too.

### Phase 2 - the desktop hub server
- [ ] Find BookForge's Bookshelf server (the in-app HTTP server) and mirror it: an HTTP
      server in Electron main serving the web build and a REST/SSE API.
- [ ] API: generation (proxied to Crucible by the hub), job events (SSE), song streaming
      with HTTP range requests, playlists, presets, tag suggestions/conflicts.
- [ ] Pairing/auth for remote devices (how Bookshelf does it), bind address choices
      (localhost, LAN), a settings toggle to share.

### Phase 3 - web client
- [ ] Transport layer in the Angular app (IPC vs HTTP) so one UI runs in both.
- [ ] Web playing list in memory/IndexedDB with a FIFO budget; cleared on close.
- [ ] Web build served by the hub; works in desktop Chrome and mobile Safari.

### Phase 4 - Crucible setup
- [ ] Setup page: install Crucible on this computer via `@crucible/bootstrap` (how
      Foundry/BookForge do it), or add/pick an existing server (pairing line).

### Phase 5 - iOS (Capacitor)
- [ ] Capacitor project wrapping the web UI; build and run on Owen's phone via Xcode on
      the Mac (no TestFlight).
- [ ] iOS audio adapter modelled on Bookshelf iOS (background audio, lock screen, now
      playing, interruptions, audio element in the DOM).
- [ ] Pick/add a hub; stream; save songs for offline; FIFO clearing of the playing list.
- [ ] Battery/heat: no polling loops; SSE with backoff; pause network work in background.

### Phase 6 - Crucible SDK gaps (in the crucible repo)
- [ ] `@crucible/client`: helpers for the playground routes (`GET /v1/playground`,
      presets) and an `instrumental` option on `audio()`; then repin B-Side.

### Later
- [ ] Albums with cover art (the `album` seam is already on every song).
