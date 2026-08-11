// Message types exchanged over the long-lived Port (name: "recorder")
// between the side panel and the background service worker.

export const PORT_NAME = 'recorder';

// Version of the on-disk session format (session.json, events.jsonl schema).
// Bump when the layout changes incompatibly; "Resume existing" refuses
// folders whose formatVersion does not match.
export const SESSION_FORMAT_VERSION = 1;

export const MSG = {
  // panel -> service worker
  START: 'start', // { tabId, autoScreenshot, sensitivity, startSeq } — startSeq > 0 continues an existing session's numbering
  STOP: 'stop', // {}
  PAUSE: 'pause', // {} — detach debugger, keep session open
  RESUME: 'resume', // {} — re-attach and continue capturing
  SCREENSHOT: 'screenshot', // {}
  SET_AUTO_SCREENSHOT: 'set-auto-screenshot', // { enabled, sensitivity }
  PING: 'ping', // {} — keepalive; receiving it resets the service worker idle timer

  // service worker -> panel
  STARTED: 'started', // { startedAt, tabUrl, tabTitle, viewport, bodyCapBytes }
  REQUEST_COMPLETE: 'request-complete', // { seq, ts, request, response, failed?, timing, body|null, bodySkipped?, bodyError?, isMainDocument }
  NAV_EVENT: 'nav-event', // { seq, ts, event, url?, frameId?, isMainFrame? }
  SCREENSHOT_DATA: 'screenshot-data', // { seq, ts, base64, dom, trigger, pageUrl, pageTitle }
  USER_EVENT: 'user-event', // { seq, ts, kind, x, y, target, form?, value?, checked? }
  WS_OPEN: 'ws-open', // { wsId, seq, ts, url }
  WS_FRAME: 'ws-frame', // { wsId, ts, dir: 'sent'|'received', opcode, payload, truncated }
  WS_CLOSE: 'ws-close', // { wsId, seq, ts, url, framesSent, framesReceived, droppedFrames }
  SSE_MESSAGE: 'sse-message', // { sseId, ts, eventName, eventId, data, truncated, first?, seq?, url? }
  PAUSED: 'paused', // { seq, ts }
  RESUMED: 'resumed', // { seq, ts }
  STOPPED: 'stopped', // { reason, detail, endedAt }
  LOG: 'log', // { ts, message }
  ERROR: 'error', // { ts, message }
};

// Auto-screenshot sensitivity presets.
// settleMs: quiet time after a view-change signal before capturing.
// minIntervalMs: minimum spacing between two auto screenshots.
// pixelDiffPct: percentage of (downscaled) screen pixels that must change
//   between two screencast frames to count as a view change.
export const SENSITIVITY = {
  fluent: { settleMs: 250, minIntervalMs: 700, pixelDiffPct: 2 },
  balanced: { settleMs: 600, minIntervalMs: 1500, pixelDiffPct: 5 },
  relaxed: { settleMs: 1000, minIntervalMs: 3000, pixelDiffPct: 12 },
};

export const STOP_REASONS = {
  USER: 'user',
  DEBUGGER_DETACHED: 'debuggerDetached',
  TAB_CLOSED: 'tabClosed',
  TAB_CRASHED: 'tabCrashed',
  WRITE_ERROR: 'writeError',
  DISCONNECTED: 'disconnected',
};
