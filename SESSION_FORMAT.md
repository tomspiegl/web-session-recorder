# Recorded Session — Analysis Guide

This document tells you (an AI assistant or a script) how to read a session
folder produced by the **Session Recorder** Chrome extension. Everything you
need is inside the folder; no access to the original website is required.

A session is one recorded browsing sequence in a web application: every
network request **with response body**, navigation events, periodic
screenshots with rendered-DOM snapshots, and diagnostics — all ordered by a
global sequence number.

## Folder layout

```
2026-08-11T14-32-05_session/        ← one folder per session (local start time)
├── session.json                    ← session-level metadata (read this first)
├── events.jsonl                    ← the master timeline (one JSON object per line)
├── session.log                     ← human-readable diagnostics/error log
├── requests/
│   ├── {seq}_{ts}_{METHOD}_{host}_{name}.{ext}          ← response body
│   └── {seq}_{ts}_{METHOD}_{host}_{name}.meta.json      ← request/response metadata
└── screenshots/
    ├── {seq}_{ts}_screenshot-{manual|auto}.png          ← screenshot
    ├── {seq}_{ts}_screenshot-{manual|auto}.dom.html     ← rendered DOM at capture time
    └── {seq}_{ts}_screenshot-{manual|auto}.meta.json    ← screenshot metadata
```

Naming grammar: `seq` is a 6-digit zero-padded counter global across ALL
artifact types; `ts` is UTC ISO-8601 with milliseconds, colons replaced by
`-` (e.g. `2026-08-11T14-32-07.123Z`). **Sorting filenames alphabetically =
chronological capture order.** Response-body extensions reflect the
Content-Type (`.json`, `.html`, `.css`, `.js`, `.xml`, images, `.bin` fallback),
so bodies are directly parseable.

## How to analyze — recommended order

1. **`session.json`** — orientation: `formatVersion` (integer; this document
   describes version **1** — if it differs, the layout may deviate from what
   is described here), optional `name` and `note` (the
   recording person's stated purpose/context — read these first), `startUrl`,
   `startedAt`/`endedAt`, `userAgent`, `viewport`, `stopReason`, and `totals`
   (request/screenshot counts). `stopReason` other than `"user"`, or a
   missing `endedAt`, means the session ended abnormally — check
   `session.log` for why. A `resumedAt` array means the session was stopped
   and continued; expect corresponding time gaps in the timeline.
2. **`events.jsonl`** — the master timeline. Parse line by line (each line is
   one JSON object; `seq` is strictly increasing). Use it as the index into
   all other files; every event carries relative paths to its artifacts.
3. Open referenced files on demand: request bodies and `.meta.json` sidecars
   from `requests/`, screenshots and DOM snapshots from `screenshots/`.

## events.jsonl — event types

Every line has `seq` (int), `ts` (ISO timestamp), `type`. Types:

```jsonc
// A completed network request (also emitted for redirects and failures):
{"seq":1,"ts":"…","type":"request","method":"GET","url":"https://…",
 "status":200,"mimeType":"application/json","failed":null,
 "bodyFile":"requests/000001_…​.json",      // null if body skipped/failed
 "metaFile":"requests/000001_….meta.json","size":18234}

// A navigation (full page load or SPA route change):
{"seq":3,"ts":"…","type":"navigation","event":"frameNavigated","url":"https://…",
 "frameId":"…","isMainFrame":true}
// event can be "frameNavigated" (new document) or
// "navigatedWithinDocument" (SPA route change via history API/hash)

// Page lifecycle markers:
{"seq":4,"ts":"…","type":"pageLoad","event":"loadEventFired"}   // or domContentEventFired

// Recording pause markers — between a "pause" and the next "resume" the user
// deliberately halted capture; nothing in that interval was recorded:
{"seq":30,"ts":"…","type":"pause"}
{"seq":31,"ts":"…","type":"resume"}

// WebSocket / Server-Sent-Events streams. The lifecycle lives here; the
// messages themselves live in a sidecar stream file (one JSON line each):
{"seq":40,"ts":"…","type":"websocket","event":"opened","url":"wss://…",
 "streamFile":"requests/000040_…_WS_host_path.ws.jsonl",
 "metaFile":"requests/000040_…_WS_host_path.meta.json"}
{"seq":95,"ts":"…","type":"websocket","event":"closed","url":"wss://…",
 "framesSent":12,"framesReceived":87,"streamFile":"…","metaFile":"…"}
{"seq":52,"ts":"…","type":"sse","event":"opened","url":"https://…",
 "streamFile":"requests/000052_…_SSE_host_path.sse.jsonl","metaFile":"…"}
// Stream sidecar line formats:
//   .ws.jsonl:  {"ts":"…","dir":"sent"|"received","opcode":1,"payload":"…","truncated":true?}
//   .sse.jsonl: {"ts":"…","eventName":"message","eventId":"42","data":"…","truncated":true?}
// Caps: payloads over 64 KB are truncated (flagged); after ~20 MB per
// connection further frames are counted in the meta but not stored.
// The .meta.json has url, openedAt, closedAt (null + openAtStop:true if the
// stream was still open when recording stopped), frame/message counts.

// A user interaction (what the user DID — correlate with nearby requests,
// navigations and screenshots to explain cause and effect):
{"seq":7,"ts":"…","type":"interaction","kind":"click","x":412,"y":230,
 "target":{"tag":"button","role":null,"selector":"#save-btn",
           "text":"Konto speichern","label":null,"href":null,"type":"submit"}}
// kind: "click" | "dblclick" | "contextmenu" | "submit" | "change" | "key"
// - submit carries  "form": {"action":"…","method":"post","id":"…"}
// - change carries  "value" (selected option label) for <select>,
//                   "checked" for checkboxes/radios
// - key carries     "key": "Enter" | "Escape"  (no other keys are recorded)
// target.selector prefers stable hooks: #id, [data-testid=…], [aria-label=…],
// [name=…], falling back to a short CSS path. target.label is the associated
// <label> text (useful to name form fields). PRIVACY: free-text input values
// and keystrokes are never recorded — submitted values appear in
// request.postData, in-progress values only in DOM snapshots.

// A screenshot:
{"seq":12,"ts":"…","type":"screenshot","trigger":"auto:view-change",
 "pageUrl":"https://…","file":"screenshots/000012_….png",
 "metaFile":"screenshots/000012_….meta.json",
 "domFile":"screenshots/000012_….dom.html",     // may be null (throttled/too large)
 "documentFile":"requests/000005_….html"}       // may be null
```

Screenshot `trigger` values: `manual` (user pressed the button/shortcut),
`auto:initial` (session start), `auto:navigation` (page load),
`auto:spa-route` (SPA route change), `auto:view-change` (visual/pixel change,
including scrolling, modals, dynamic content).

## requests/*.meta.json — per-request detail

```jsonc
{
  "seq": 1, "ts": "…",
  "request": {
    "url": "…", "method": "POST",
    "headers": { … },
    "postData": "…",              // SUBMITTED FORM/JSON DATA lives here
    "resourceType": "XHR",        // Document | XHR | Fetch | Script | Stylesheet | Image | …
    "initiator": { … },           // what caused this request (script stack / parser)
    "redirectChain": ["…"]        // URLs of prior redirect hops, oldest first
  },
  "response": {
    "status": 200, "statusText": "OK", "headers": { … },
    "mimeType": "…", "remoteIPAddress": "…", "protocol": "h2",
    "fromDiskCache": false, "fromServiceWorker": false,
    "servedFromCache": false, "encodedDataLength": 1234
  },
  "failed": { "errorText": "net::ERR_…", "canceled": false },  // only on failures
  "timing": { "startedAt": "…", "durationMs": 132 },
  "body": {
    "bodyFile": "requests/….json", "bodySize": 18234, "base64Encoded": false
    // OR: "bodySkipped": "size" | "scheme" | "redirect" | "resourceType:…"
    //     | "sessionStopped" (request still in flight when recording ended)
    // OR: "bodyError": "evicted" — metadata kept, body unavailable
  }
}
```

Key points:
- **User-submitted data** (form fields, JSON payloads) is in `request.postData`
  of POST/PUT/PATCH requests. Data typed but never submitted is NOT recorded
  as data — it is only visible in screenshots and DOM snapshots.
- To find what the app sent when the user clicked "Save", look for the
  POST/PUT request nearest (by `seq`/`ts`) to the relevant screenshot.

## screenshots/ — three files per capture

- **`.png`** — what the user saw.
- **`.dom.html`** — the RENDERED DOM serialized at capture time. For SPAs
  (React/Angular/Vue) this is the framework-built state — analyze this, not
  the delivered HTML, to understand what was on screen. May be absent for
  some auto shots (throttled to one per 3 s) — fall back to the nearest
  earlier screenshot's DOM.
- **`.meta.json`** — `{ seq, ts, trigger, pageUrl, pageTitle, screenshotFile,
  domFile, document: {url, file, seq} }` where `document.file` points to the
  network-delivered main-frame HTML in `requests/` (the initial shell).

## session.log

Timestamped diagnostics: `<ISO ts> [info|error] message`. Contains start/stop
events, every error, crash reasons, and re-attach notices. Read it whenever a
session ended with an unexpected `stopReason` or you see gaps in the timeline.

## Caveats to keep in mind

- **Bodies can be missing** by design: check `body.bodySkipped` /
  `body.bodyError` in the meta file. Skips: >20 MB (`size`), `data:`/`blob:`
  URLs (`scheme`), redirect hops (`redirect`), streaming types. Metadata is
  always present.
- **Capture gaps:** a `session.log` line "Debugger re-attached after target
  swap" marks a ~0.5–1 s gap (caused e.g. by password-manager popups);
  requests during the gap were not captured.
- **Redirects:** each hop is a separate `request` event; the final response
  carries the body, hops carry `redirectChain`.
- **Aborted sessions:** `session.json` without `endedAt` (or missing) means
  the recording was cut off; `events.jsonl` is still valid up to its last line.
- Timestamps: `ts` is the capture/emission time (UTC). Request start time and
  duration are in the meta file's `timing`.
- One root folder may contain several `…_session` folders — they are
  independent consecutive recordings (a crash-interrupted run appears as two).

## Example tasks and how to do them

- **"Reconstruct what the user did":** walk `events.jsonl` in `seq` order;
  `interaction` events are the user's actions (clicks with element text/
  selector, submits, Enter/Escape); `navigation` events (main-frame only) and
  `screenshot` events show the resulting views (view the PNGs / diff
  consecutive `.dom.html` files); attach nearby XHR requests as the app's
  reaction. A typical causal chain reads: click → XHR(s) → view-change
  screenshot.
- **"What data was saved to the backend?"**: filter `request` events with
  `method` POST/PUT/PATCH, read `request.postData` from each `metaFile`, pair
  with the response body for the server's answer.
- **"Why did view X show value Y?"**: find the screenshot showing X, grep its
  `.dom.html` for Y, then search earlier `requests/*.json` bodies for Y to
  identify the API response that delivered it.
- **"Find errors":** `request` events with `failed` set or `status >= 400`,
  plus `[error]` lines in `session.log`.
