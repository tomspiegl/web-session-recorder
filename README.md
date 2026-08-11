# Session Recorder

A Chrome extension (Manifest V3, vanilla JS, no build step) that records a web
session for later inspection: as you click through a web application, **all
network traffic — including full response bodies** (JSON, XML, HTML, CSS,
JavaScript, images, …), automatic and on-demand **screenshots with
rendered-DOM snapshots**, **navigation events** and **user interactions**
(which element was clicked) are written live into a folder you pick on disk.
Every artifact is prefixed with a global sequence number and timestamp, so
sorting files alphabetically equals chronological capture order — and every
session folder is self-describing ([SESSION_FORMAT.md](SESSION_FORMAT.md)),
ready to hand to an AI assistant for analysis.

## Install

Chrome cannot install extensions directly from a GitHub URL — get the code
locally, then load it unpacked:

1. `git clone https://github.com/tomspiegl/web-session-recorder.git`
   — or **Code → Download ZIP** on GitHub and unzip.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the project directory.
4. Click the extension's toolbar icon to open the **Session Recorder** side panel.

To update: `git pull` (or re-download), then press ↻ on the extension's card.
Requires Chrome 116+.

## Usage

1. Open the web application you want to record in a normal `http(s)` tab.
2. In the side panel, pick that tab from the dropdown. Optionally give the
   session a **name** (becomes part of the folder name and `session.json`;
   defaults to the site's domain) and a **note** (purpose, ticket, context —
   stored in `session.json` for whoever analyzes the recording).
3. Click **Start new** and choose (or create) a target folder — a fresh
   session folder is created inside it (grant the "save changes" permission
   when Chrome asks). Or click **Resume existing…** and pick a previous
   session folder (or its parent — the newest session inside is used):
   recording appends to it — sequence numbers, `events.jsonl` and
   `session.log` carry on, and `session.json` collects resume times in
   `resumedAt`. The folder is validated first (must contain `events.jsonl`
   and a `session.json` whose `formatVersion` matches the current format).
4. Chrome shows a *"Session Recorder started debugging this browser"* infobar —
   this is expected (the extension uses the DevTools protocol to capture
   response bodies). **Do not click "Cancel"** on it and do not open DevTools
   on the recorded tab; either ends the session.
5. Click through the application. Requests appear in the live capture log.
6. **Screenshots are automatic**: a shot is taken right at session start, then
   on every full page load, SPA route change (history API / hash navigation),
   and on **visual change** — Chrome's screencast pushes a small preview frame
   whenever the tab's pixels change; the recorder diffs consecutive frames and
   captures once enough of the screen changed. This covers scrolling, modals,
   in-page tab switches and dynamically loaded content alike, while noise like
   a blinking caret stays below threshold. The **Auto-screenshot** sensitivity
   selector controls how much of the screen must change — *Fluent* (~2%),
   *Balanced* (~5%), *Relaxed* (~12%), or **Off** (manual screenshots only) —
   changeable mid-recording. Every
   captured shot appears as a flashing thumbnail in the panel. The big
   **📷 Take screenshot** button adds extra shots on demand at any time — or
   press **Alt+Shift+S** while working in the page (configurable at
   `chrome://extensions/shortcuts`).
   Each screenshot also stores a **rendered-DOM snapshot** (`…dom.html`) —
   for SPAs (React/Angular/…) this is the framework-built DOM at capture
   time, unlike the initial HTML shell delivered over the network.
7. **⏸ Pause / ▶ Resume** halts capture inside the running session: pausing
   fully detaches the debugger (the infobar disappears, nothing is recorded),
   resuming re-attaches and continues with the same numbering; `pause`/`resume`
   markers land in `events.jsonl`.
8. Click **Stop**. The session is finalized on disk. The current session
   folder name is always shown in the panel.

## Replaying a session

Click **Open session viewer** at the bottom of the side panel (or open the
extension's `viewer/viewer.html` page). Pick a session folder — or a folder
containing several sessions, then choose one from the dropdown. You get:

- a filterable **timeline** of every recorded event (requests, navigations,
  screenshots, user interactions) in capture order, with a text filter that
  searches URLs and clicked-element text/selectors,
- a **detail pane**: click any request to see its metadata, submitted payload
  and body (pretty-printed JSON, text, images; binaries downloadable), click
  any screenshot to see it full-size with its page URL, its rendered-DOM
  snapshot and a link to the delivered HTML document, click any interaction
  to see exactly which element was used,
- **replay controls**: ▶ plays the session's screenshots back using the real
  time gaps between them (scaled by the speed selector, long gaps capped),
  with prev/next stepping; **paused periods are skipped by default**
  (uncheck "skip pauses" to keep them).

This is a *timeline replay* of what was recorded. It does not re-execute the
application against the recorded responses — a live re-run depends on auth,
server state and request ordering, and would be unreliable.

## Output format

The full format specification lives in [SESSION_FORMAT.md](SESSION_FORMAT.md) —
written so it can be handed to an AI assistant together with a session folder
("here is a recorded session, analyze it"). A copy is automatically placed
inside every new session folder.

One folder per session inside the folder you picked:

```
2026-08-11T14-32-05_myapp.example.com/        ← <timestamp>_<name|domain>
├── session.json          formatVersion, name, note, startedAt/endedAt,
│                         resumedAt[], start URL, tab title, user agent,
│                         Chrome version, viewport, sensitivity,
│                         stopReason/stopDetail, totals
├── events.jsonl          machine-readable index: one JSON line per event
│                         (request | navigation | pageLoad | screenshot |
│                          interaction | pause | resume), in order
├── session.log           timestamped diagnostics and errors
├── SESSION_FORMAT.md     copy of the format spec (self-describing folder)
├── requests/
│   ├── 000001_2026-08-11T14-32-07.123Z_GET_example.com_index.html       ← response body
│   └── 000001_2026-08-11T14-32-07.123Z_GET_example.com_index.meta.json ← metadata sidecar
└── screenshots/
    ├── 000047_2026-08-11T14-33-10.502Z_screenshot-manual.png
    ├── 000047_2026-08-11T14-33-10.502Z_screenshot-manual.dom.html      ← rendered DOM
    └── 000047_2026-08-11T14-33-10.502Z_screenshot-manual.meta.json
```

- File names are `{seq}_{timestamp}_…` where `seq` is a 6-digit global counter
  shared by requests, navigations and screenshots — alphabetical sort in any
  file manager is chronological order.
- Response bodies get a real extension derived from their `Content-Type`
  (`.json`, `.html`, `.css`, `.js`, `.xml`, images, fonts; `.bin` fallback),
  so they open directly in editors and are greppable.
- Each request's `.meta.json` sidecar contains the request (URL, method,
  headers, POST data, initiator, redirect chain), response (status, headers,
  MIME type, remote IP, protocol, cache flags, transfer size), timing, and a
  pointer to the body file — or `bodySkipped` / `bodyError` with a reason.
- Each screenshot is named `…_screenshot-manual.png` or `…_screenshot-auto.png`
  and comes with two sidecars sharing its basename: `…dom.html` (the rendered
  DOM at capture time) and `.meta.json` with the trigger (`manual`,
  `auto:initial`, `auto:navigation`, `auto:spa-route`, `auto:view-change`), the
  page URL and title at capture time, the `domFile` link, and a `document`
  link to the network-delivered main-frame HTML in `requests/` — so every
  screenshot can be traced to both the delivered HTML and the DOM the app
  actually built.
- Submitted form/JSON data (POST/PUT bodies) is recorded in each request's
  `.meta.json` under `request.postData` (fetched explicitly for large bodies);
  the viewer shows it as a "Request payload" section. Input that is typed but
  never submitted only appears in screenshots and DOM snapshots — field values
  are not key-logged.
- `stopReason` in `session.json` is one of `user`, `debuggerDetached`,
  `tabClosed`, `tabCrashed`, `writeError`, `disconnected` (plus `stopDetail`
  where Chrome provides one, e.g. `canceled_by_user`). A session folder whose
  `session.json` has no `endedAt` was aborted (e.g. the side panel was closed
  mid-recording).

## Crash handling & diagnostics

- Every session folder contains a **`session.log`**: all panel and worker log
  lines, every error, and the final stop reason, timestamped. Error lines are
  flushed to disk immediately so they survive a crash. Uncaught errors in the
  panel and the worker are hooked globally and land there too — analyze this
  file (plus `stopReason`/`stopDetail` in `session.json`) after any crash.
- If a session dies without the user stopping it (service worker killed, tab
  renderer crash, unexpected debugger detach), the interrupted session is
  finalized on disk and the panel shows a red alert banner plus a `!` badge
  on the toolbar icon. Recording is **not** restarted automatically — use
  **Start new** or **Resume existing…** (to append to the interrupted
  session's folder) when you're ready.
- **Automatic re-attach:** when the debugger detaches with `target_closed`
  while the tab still exists — prerender/back-forward-cache activation,
  process swap, or a foreign extension injecting a frame Chrome won't let us
  debug (password managers like 1Password do this on focused form fields) —
  the recorder re-attaches within ~1 s and the SAME session continues; a log
  line marks the gap. For gap-free recordings on sites where a password
  manager pops up, disable that extension for the site being recorded.
- Two independent keepalives counter the MV3 service worker idle timeout:
  the panel pings every 15 s and the worker resets its own idle timer every
  20 s via an extension API call.
- Auto shots take a DOM snapshot at most every 3 s (manual shots always) to
  keep bursts — e.g. pixel-change shots while typing — lightweight.

## Limits and known behavior

- **Body size cap: 20 MB** per response (`BODY_CAP_BYTES` in `background.js`).
  Larger bodies are skipped; metadata is still recorded with `bodySkipped: "size"`.
- Bodies are also skipped for `data:`/`blob:`/`about:` URLs, redirect hops
  (redirects have no body), and streaming resource types
  (`EventSource`, `WebSocket`, `Media`).
- **WebSocket frames are not captured** in v1 (connection metadata is recorded).
- Response bodies evicted by Chrome before they could be fetched (rare; mostly
  on very fast navigations) are recorded as `bodyError` — metadata is never lost.
- Closing the side panel aborts the session (the panel performs the disk
  writes). Keep it open while recording.
- One recording session at a time.
- **User interactions are recorded**: clicks/double-clicks/context-menu with
  the target element (stable selector preferring id/data-testid/aria-label/
  name, tag, role, trimmed text, link href, associated label), form submits
  (action/method — no field values), select/checkbox/radio changes (chosen
  label/state), and Enter/Escape presses. They appear as `interaction` events
  in `events.jsonl`. Capture uses a small passive hook injected into the page;
  it records no keystrokes and no free-text values.
- Visual-change detection runs entirely inside the extension (CDP screencast
  frames diffed on a 48×48 grid in the service worker). Frames are only sent
  by Chrome while the tab is visible and its pixels change. Sensitivity
  presets live in
  `shared/protocol.js` (`SENSITIVITY`: settle delay, minimum interval between
  auto shots, changed-pixel percentage). During sustained change (long
  scrolls, animations) a pending shot fires at the latest after twice the
  minimum interval, so fluent mode keeps capturing mid-scroll.
- Only `http(s)` tabs can be recorded (Chrome forbids debugging `chrome://`
  and extension pages).

## Privacy & data handling

Everything stays local: no server, no telemetry, no network requests by the
extension itself — see [PRIVACY.md](PRIVACY.md). **Recordings can contain
sensitive data** from the recorded site (cookies, tokens, personal data,
submitted forms). Treat session folders as confidential, never commit them to
version control (the `.gitignore` here excludes `*_session/` folders), and
prefer test accounts when recording apps that handle real personal data. Only
record applications you are authorized to test.

## License

[MIT](LICENSE)

## Architecture (for maintainers)

- `background.js` — service worker; owns the `chrome.debugger` (CDP) session:
  attaches to the tab, enables `Network` + `Page`, fetches each response body
  immediately on `Network.loadingFinished` (bodies are evicted on navigation),
  assigns global sequence numbers, streams assembled records to the panel.
  Never touches the filesystem.
- `sidepanel/panel.{html,css,js}` — UI and session state machine
  (`idle → picking-folder → starting → recording ⇄ paused → stopping`).
- `sidepanel/writer.js` — `SessionWriter`; owns the `FileSystemDirectoryHandle`
  (only an extension page with a user gesture may call `showDirectoryPicker`)
  and performs all writes through a serialized queue; `events.jsonl` appends
  are batched (500 ms / 25 lines).
- `viewer/viewer.{html,css,js}` — extension page for inspecting and replaying
  recorded sessions (timeline, body previews, screenshot playback).
- `shared/protocol.js` — message types for the panel⇄worker Port.
- `shared/mime.js` — MIME→extension map, filename sanitizing, timestamps, base64.
