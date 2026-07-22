# Endgame — Chess (single player, local 2P, online 2P)

A fully static chess site. No build step, no backend, no database.

## What it does

- **Single player** — play against a built-in engine (minimax + alpha-beta,
  three difficulty levels), running in a Web Worker so the board never freezes.
- **Two player, same screen** — pass-and-play locally.
- **Two player, online** — one person hosts, gets a shareable link, sends it
  to a friend. The two browsers connect directly over WebRTC (via PeerJS).
  There is no game server: moves travel peer-to-peer once the link is opened.
  A public PeerJS broker (`0.peerjs.com`, free, run by the PeerJS project) is
  used only for the initial handshake, the same job an ICE/STUN server does.
- **Spectators** — the host can also share a second, read-only "watch" link
  (adds `&watch=1`) so others can follow an online game live without being
  able to move anything. Works mid-game too, and catches a reconnecting
  spectator back up on whatever they missed.
- **Sound** — move/capture/check/game-end effects, synthesized on the fly
  (no audio files to ship), toggleable from the board controls.
- **Puzzles** — a small bundled set of tactics (mate-in-1/2, forks, pins).
  Every solution line ships pre-verified against chess.js itself, not typed
  in from memory. Progress is remembered locally so it resumes where you
  left off.

## Files

```
index.html        Page structure, all three screens (home / setup / game)
css/style.css      All styling (no framework)
js/engine.js        Thin wrapper around chess.js (rules + move legality)
js/board.js         Board rendering + click-to-move interaction
js/ai-worker.js      The engine, in a Web Worker
js/network.js        PeerJS wrapper: host(), join(), send(), on()
js/main.js           App state machine wiring everything together
```

`chess.js` (the rules engine) and `peerjs` are both loaded from public CDNs
at runtime (`cdn.jsdelivr.net` and `unpkg.com`) — nothing to install, nothing
to bundle.

## Deploying to GitHub Pages

This repo deploys itself via GitHub Actions (`.github/workflows/deploy-pages.yml`),
which also stamps the service worker with a fresh cache version on every
push — see "It's installable" below.

1. Create a new repository and push these files, keeping the same structure
   (`index.html` at the root, `.github/workflows/`, `css/`, `js/`, `icons/`
   alongside it).
2. In the repo: **Settings → Pages → Source → GitHub Actions** (not
   "Deploy from a branch" — the workflow needs to be the one publishing).
3. Push to `main`. The **Deploy to GitHub Pages** workflow runs automatically;
   watch it in the **Actions** tab. First run takes a minute or two.
4. Visit `https://<username>.github.io/<repo>/`.

From then on, every push to `main` redeploys automatically — nothing to run
by hand.

## It's installable (PWA)

The site is a Progressive Web App:

- **`manifest.json`** — name, icons, and `display: standalone` so it can be
  added to a home screen / installed as a desktop app, opening without
  browser chrome.
- **`sw.js`** — a service worker that caches the app shell (HTML/CSS/JS/icons)
  plus the CDN dependencies (chess.js, PeerJS, webfonts) the first time
  they're fetched. After that first visit, **Single Player** and **Two
  Player — Same Screen** keep working with no network at all. **Play
  Online** still needs a live connection, since it has to reach another
  browser.
- Icons live in `icons/` (16px up to 512px, plus maskable variants for
  Android's adaptive-icon shape) and `favicon.ico` at the root.

**Cache versioning is automatic** — no manual steps, no stale copies:

1. On every push, the deploy workflow rewrites `CACHE_VERSION` in `sw.js` to
   that commit's short SHA plus a timestamp, so every deploy gets a cache
   name no previous deploy has ever used.
2. When a visitor's browser sees the new service worker, it installs it in
   the background, activates it immediately, and deletes the old cache.
3. `js/main.js` listens for that handover and reloads the open tab once, so
   people land on the new build instead of quietly sitting on the old one
   until their next manual refresh.

The `CACHE_VERSION` value committed in the repo (`"local-dev"`) is only ever
seen if you open `index.html` straight from disk or a non-Actions deploy —
on GitHub Pages it's always overwritten by the workflow before publishing.

## Notes on the online mode

- The host is always **White**, the joiner is always **Black**.
- The invite link looks like `.../index.html?room=endgame-ab12cd`. Opening it
  auto-detects the `room` parameter and joins immediately — no extra steps
  for the guest.
- If the peer disconnects mid-game, the board says so and both sides try to
  reconnect automatically (the guest redials the host, the host restores its
  link to the broker so a reconnecting guest has somewhere to dial back
  into). On reconnect the two browsers exchange a `sync` message so whoever
  missed moves while disconnected catches back up. If reconnecting doesn't
  work out, a fresh link/rematch is still the fallback.
- Because everything is peer-to-peer, both browsers must be able to open a
  WebRTC connection to each other. This works in the vast majority of home
  and mobile networks; a small number of very restrictive corporate networks
  may block it.

## Extending it

- Swap the AI's evaluation function in `js/ai-worker.js` for something
  stronger (deeper search, better tables, opening book) without touching
  anything else.
- The network protocol in `js/network.js`/`js/main.js` is a handful of plain
  JSON message types (`move`, `resign`, `chat`, `rematch`) — easy to extend
  with e.g. draw offers or spectator mode.
