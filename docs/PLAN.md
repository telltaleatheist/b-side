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

## The hub design (worked out 2026-10-04 overnight, from the architecture above)

- **One transport: HTTP + SSE to the hub, for every client, the desktop window included.**
  The plan first said "IPC on desktop, HTTP on web/iOS"; two transports means two code
  paths that drift (BookForge has three players for exactly this reason). So main runs the
  hub server always (on 127.0.0.1 alone until sharing is turned on), and the Electron
  window is just its first client. The preload bridge shrinks to the acts only a desktop
  can do: pick the library folder, show a song in its folder, save a copy through a dialog.
- **The hub server** (mirrors Bookshelf's): `node:http` in main, the built Angular app at
  `/`, the API at `/api`. Every `/api` request carries the hub key (`X-BSide-Key`, or
  `?key=` where an `<audio>` src or EventSource cannot set a header). Wildcard CORS,
  because the Capacitor app calls from `capacitor://localhost`. Bind: 127.0.0.1 by default;
  Settings -> "Share on my network" binds 0.0.0.0 and shows the link (with key) to open on
  a phone or another computer.
- **Clients** have an id and a kind. The desktop window is `desktop`. A browser tab makes
  a random id in sessionStorage (dies with the tab). The iOS app keeps its id.
- **Takes** = generated songs nobody saved. The hub fetches each finished job's audio into
  `<userData>/takes/` (audio + sidecar naming its client). A client's **playing list** is
  its takes, oldest first. Retention, all FIFO (oldest first), all well under any limit:
  - per client: desktop 200 takes, iOS 60, web 40;
  - all takes together: 4 GB on the hub's disk (a 3-minute YuE song is ~35 MB);
  - a web client's takes are deleted 10 minutes after its tab stops listening (the grace
    is for a reload or a network blip) - "clears when the browser closes".
- **Playlists** live in the library folder (`playlists.json`) and their songs are the
  library's songs (audio + sidecar, as v1). "Save to playlist" copies a take into the
  library (once - a take saved to a second playlist reuses the same song). A song that
  leaves its last playlist is deleted (the UI says so before it does). v1 library songs
  that are in no playlist are adopted into a playlist named "Saved before playlists".

## Tasks

### Phase 0 - review v1
- [x] Review the v1 built 2026-10-04 (all of `electron/`, `src/`, `shared/`): correctness,
      no fallbacks/band-aids, matches Foundry's patterns. Findings: the code is sound (the
      job runner's submit line, install follow, reconnect-with-last-event-id and atomic
      library writes are right); the one structural problem is the architecture, not the
      code - every finished job lands straight in the library and the renderer is IPC-only,
      which the hub design above replaces.
- [x] Prove the receive side (done event -> artifact -> library) with ONE real render.
      Owen gave the GPU go for B-Side test renders on 2026-10-04 ("GPU is yours").
      Done 2026-10-04 01:27 on the PC: JobRunner + Library driven headless (no Electron),
      queued -> composing -> synthesizing -> decoding -> done in ~60 s, 34.2 s of audio,
      6.5 MB FLAC fetched and filed with its sidecar (seed 2481639261).

### Phase 1 - playing list vs playlists
- [x] Split the model: the playing list (ephemeral session queue) vs named playlists.
      Generated songs land in the playing list; only "Save to playlist" copies a song into
      the library folder. (a142217: `takes.ts`, `library.ts`; verified from a browser tab.)
- [x] Playlist CRUD (create, rename, delete, add/remove/reorder songs) and a playlists view
      to play a saved playlist. (Playlists page; bun tests cover every rule.)
- [x] Desktop playing list: decide its own retention (temp folder, FIFO cap) - songs not
      saved are temporary on desktop too. (The take cache: desktop 200 takes, 4 GB overall.)

### Phase 1b - describe it, get the tags (Owen, 2026-10-04)
- [x] "Describe the music" box: e.g. "in the style of One Must Fall 2097, the DOS game" or
      "smooth lo-fi with jazz/sax" -> a small Crucible LLM (`qwen3.5-4b`, installed on the
      PC) fills the tag chips. It picks from the server's own tag vocabulary (the song
      page's suggestions + conflicts), adds free text only for BPM/key, and the result is
      checked against the conflict map before it reaches the chips. The hub makes the call
      (it holds the Crucible token), through the same `/api` as everything else.
      Built 2026-10-04 (`electron/describe.ts`, `POST /api/describe`, the studio box).
      The vocabulary is EXAMPLES in the prompt, not a closed list (YuE2 takes any phrase;
      song.toml has no "chiptune"); fields are held to a JSON schema. Tried on the PC:
        "smooth lo fi with jazz/sax" -> English, lo-fi, jazz, dreamy, nostalgic,
          saxophone, piano, acoustic guitar, light drums, vintage sound, smooth production, 90 BPM
        "one must fall 2097 dos game" -> first try orchestral/strings/piano (wrong); after
          one worked example of describing a retro game by its sound tech: chiptune,
          electronic rock, industrial, FM synth leads, tracker drums, Sound Blaster FM,
          140 BPM - but it still added male vocals (the 4B does not always obey
          "a game soundtrack is instrumental").
        "a sad country song about my dog" -> country, acoustic ballad, melancholic, soft
          female voice, acoustic guitar, fiddle, 70 BPM.
- [x] Measure the swap first: Crucible holds one model per card, so on the PC (YuE ~16 GB
      of 24 GB) describing evicts YuE and the next song reloads it. Time both loads, say
      the cost in the UI ("swaps the song model out for ~N s"), and describe once per batch.
      Measured on the PC 2026-10-04: EVERY describe costs ~80 s (176 s the very first time,
      torch.compile), because Crucible unloads an LLM the moment its chat finishes when
      nothing holds it, so each chat starts vLLM from scratch: ~23 s Python start, ~12 s
      weights, ~21 s engine init, ~18 s API server. YuE2 then reloads in ~25 s. So a
      describe is ~1:45 of card time on the PC. Fixing that is Crucible's: a short hold
      after a chat when no song is waiting, and/or a faster engine start. For Owen.

### Phase 2 - the desktop hub server
- [x] Find BookForge's Bookshelf server (the in-app HTTP server) and mirror it: an HTTP
      server in Electron main serving the web build and a REST/SSE API. (`electron/hub/`.)
- [x] API: generation (proxied to Crucible by the hub), job events (SSE), song streaming
      with HTTP range requests, playlists, presets, tag suggestions/conflicts.
- [x] Pairing/auth for remote devices (how Bookshelf does it), bind address choices
      (localhost, LAN), a settings toggle to share. Key + link (`/#key=`), 127.0.0.1 by
      default. NOT yet exercised live: turning sharing ON (binding 0.0.0.0 makes Windows
      show a firewall prompt, which nobody was awake to answer) - Owen's first try.

### Phase 3 - web client
- [x] Transport layer in the Angular app (IPC vs HTTP) so one UI runs in both. Decided:
      HTTP everywhere (`HubService`), the desktop window included; see the hub design.
- [x] Web playing list in memory/IndexedDB with a FIFO budget; cleared on close. Decided:
      the hub keeps every playing list (a browser stores nothing but its key); a tab's
      list has a 40-take FIFO and is cleared 10 min after the tab stops listening.
- [ ] Web build served by the hub; works in desktop Chrome and mobile Safari. Desktop
      Chrome verified (Mac Chrome -> PC hub, real render, save to playlist); the Electron
      window verified over CDP. Mobile Safari not yet tried.

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
