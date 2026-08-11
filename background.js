// Background service worker: owns the chrome.debugger (CDP) session.
// Captures network traffic with full response bodies, navigation events and
// on-demand screenshots, assigns a global sequence number to every event and
// streams assembled records to the side panel, which does all file writes.

import { MSG, PORT_NAME, STOP_REASONS, SENSITIVITY } from './shared/protocol.js';

const BODY_CAP_BYTES = 20 * 1024 * 1024;
const SKIP_SCHEMES = ['data:', 'blob:', 'chrome-extension:', 'about:'];
const SKIP_RESOURCE_TYPES = new Set(['EventSource', 'WebSocket', 'Media']);

// Visual change detection: CDP screencast pushes a small preview frame ONLY
// when the tab's pixels actually change (compositor-driven — no polling).
// Consecutive frames are downscaled and diffed here; when more than the
// sensitivity's pixelDiffPct of the screen changed, a screenshot is scheduled.
// This covers scrolling, modals, tab switches and dynamic content alike,
// while sub-threshold noise (blinking caret, hover highlights) is ignored.
const SCREENCAST_OPTS = {
  format: 'jpeg',
  quality: 40,
  maxWidth: 320,
  maxHeight: 320,
  everyNthFrame: 4,
};
// DOM snapshots beyond this size are dropped (screenshot is still taken).
const DOM_SNAPSHOT_CAP_CHARS = 10_000_000;
// Auto shots take a DOM snapshot at most this often (manual shots always do).
// Typing fires pixel-change shots on every keystroke burst; shipping a full
// DOM with each was the prime overload suspect.
const DOM_SNAPSHOT_MIN_INTERVAL_MS = 3000;
// Belt and braces alongside the panel's pings: while a session is active the
// worker also resets its own idle timer.
const KEEPALIVE_INTERVAL_MS = 20_000;
const DIFF_SIZE = 48; // frames are diffed on a DIFF_SIZE × DIFF_SIZE grid
const DIFF_PIXEL_DELTA = 40; // summed |ΔR|+|ΔG|+|ΔB| for a pixel to count as changed

let diffCanvas = null;
let diffCtx = null;

// Interaction capture: a passive hook injected into the recorded page.
// Records WHICH element the user clicked (stable selector, role, text, href),
// form submits, select/checkbox/radio changes and Enter/Escape presses.
// PRIVACY: no keystrokes, no free-text values — submitted data is already in
// request.postData, in-progress values are visible in DOM snapshots.
const INTERACTION_BINDING = '__recorderUserEvent';
const INTERACTION_HOOK_SOURCE = `(() => {
  if (window.__recorderInteractionHooked) return;
  window.__recorderInteractionHooked = true;

  const attr = (el, name) => el.getAttribute && el.getAttribute(name) || undefined;

  function stableSelector(el) {
    if (el.id) return '#' + el.id;
    const testid = attr(el, 'data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    const tag = el.tagName.toLowerCase();
    const aria = attr(el, 'aria-label');
    if (aria) return tag + '[aria-label="' + aria + '"]';
    const name = attr(el, 'name');
    if (name) return tag + '[name="' + name + '"]';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      let seg = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(seg);
      n = parent;
    }
    return parts.join('>');
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const link = el.closest ? el.closest('a[href]') : null;
    let label;
    if (el.id && window.CSS && CSS.escape) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) label = l.innerText.trim().slice(0, 100) || undefined;
    }
    if (!label && el.closest) {
      const l = el.closest('label');
      if (l) label = l.innerText.trim().slice(0, 100) || undefined;
    }
    return {
      tag: el.tagName.toLowerCase(),
      role: attr(el, 'role'),
      selector: stableSelector(el),
      text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 100) || undefined,
      href: link ? link.href : undefined,
      label,
      type: attr(el, 'type'),
    };
  }

  function report(kind, e, extra) {
    try {
      let t = e.target;
      if (t && t.nodeType !== 1) t = t.parentElement;
      window.${INTERACTION_BINDING}(JSON.stringify(Object.assign(
        { kind, x: e.clientX, y: e.clientY, target: describe(t) }, extra || {})));
    } catch (err) {}
  }

  const opts = { capture: true, passive: true };
  addEventListener('click', (e) => report('click', e), opts);
  addEventListener('dblclick', (e) => report('dblclick', e), opts);
  addEventListener('contextmenu', (e) => report('contextmenu', e), opts);
  addEventListener('submit', (e) => {
    const f = e.target;
    report('submit', e, { form: { action: f.action, method: f.method, id: f.id || undefined } });
  }, opts);
  addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      report('change', e, { value: (el.options[el.selectedIndex] || {}).text });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      report('change', e, { checked: el.checked });
    }
    // free-text inputs: deliberately not recorded
  }, opts);
  addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') report('key', e, { key: e.key });
  }, opts);
})();`;

// Single active session or null.
// { tabId, port, seq, pending: Map<requestId, entry>, mainFrameId,
//   autoScreenshot, cfg, autoTimer, lastAutoShotAt, prevFrame, diffBusy }
let session = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Nothing may fail silently: uncaught worker errors are forwarded to the
// panel, which persists them to the session folder's session.log.
self.addEventListener('error', (e) => {
  if (session) postError(session.port, `Worker error: ${e.message}`);
});
self.addEventListener('unhandledrejection', (e) => {
  if (session) postError(session.port, `Worker unhandled rejection: ${e.reason?.message || e.reason}`);
});

// Keyboard shortcut (default Alt+Shift+S): extra screenshot without needing
// the side panel focused.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'take-screenshot' && session) takeScreenshot('manual');
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case MSG.START:
        startSession(port, msg.tabId, !!msg.autoScreenshot, msg.sensitivity, msg.startSeq || 0);
        break;
      case MSG.STOP:
        if (session && session.port === port) endSession(STOP_REASONS.USER);
        break;
      case MSG.PAUSE:
        if (session && session.port === port) pauseSession();
        break;
      case MSG.RESUME:
        if (session && session.port === port) resumeSession();
        break;
      case MSG.SCREENSHOT:
        if (session && session.port === port) takeScreenshot('manual');
        break;
      case MSG.PING:
        // Port messages alone do not reliably reset the service worker idle
        // timer; calling any extension API does (documented behavior). This
        // keeps the worker alive through quiet phases (user typing, no
        // traffic) — the suspected cause of sessions dying mid-recording.
        chrome.runtime.getPlatformInfo(() => {});
        break;
      case MSG.SET_AUTO_SCREENSHOT:
        if (session && session.port === port) {
          session.autoScreenshot = !!msg.enabled;
          if (SENSITIVITY[msg.sensitivity]) session.cfg = SENSITIVITY[msg.sensitivity];
          if (!session.autoScreenshot && session.autoTimer) {
            clearTimeout(session.autoTimer);
            session.autoTimer = null;
          }
        }
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // Panel closed mid-session: abort. The panel is the writer, so nothing
    // more can be persisted anyway; just release the debugger.
    if (session && session.port === port) {
      const target = { tabId: session.tabId };
      if (session.autoTimer) clearTimeout(session.autoTimer);
      clearInterval(session.keepAliveTimer);
      session = null;
      chrome.debugger.detach(target).catch(() => {});
    }
  });
});

async function startSession(port, tabId, autoScreenshot, sensitivity, startSeq = 0) {
  if (session) {
    postError(port, 'Already recording another session.');
    return;
  }
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    postError(port, `Could not attach debugger: ${e.message}. Close DevTools on that tab and retry.`);
    return;
  }

  session = {
    tabId,
    port,
    seq: startSeq, // continues numbering when resuming an existing session

    pending: new Map(),
    mainFrameId: null,
    autoScreenshot,
    cfg: SENSITIVITY[sensitivity] || SENSITIVITY.balanced,
    autoTimer: null,
    autoPendingSince: null,
    lastAutoShotAt: 0,
    prevFrame: null,
    diffBusy: false,
    lastDomAt: 0,
    reattaching: false,
    paused: false,
    keepAliveTimer: setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_INTERVAL_MS),
  };

  try {
    await enableDomains(target);
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const tab = await chrome.tabs.get(tabId);
    const viewportSrc = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    port.postMessage({
      type: MSG.STARTED,
      startedAt: new Date().toISOString(),
      tabUrl: tab.url,
      tabTitle: tab.title,
      viewport: { width: viewportSrc.clientWidth, height: viewportSrc.clientHeight },
      bodyCapBytes: BODY_CAP_BYTES,
    });
    // First view: capture right away in auto mode.
    if (session.autoScreenshot) scheduleAutoScreenshot('auto:initial');
  } catch (e) {
    session = null;
    chrome.debugger.detach(target).catch(() => {});
    postError(port, `Could not start recording: ${e.message}`);
  }
}

/** Enable all CDP domains for a (re-)attached target. */
async function enableDomains(target) {
  await chrome.debugger.sendCommand(target, 'Network.enable', {
    maxTotalBufferSize: 200_000_000,
    maxResourceBufferSize: 50_000_000,
  });
  await chrome.debugger.sendCommand(target, 'Page.enable');
  const frameTree = await chrome.debugger.sendCommand(target, 'Page.getFrameTree');
  if (session) session.mainFrameId = frameTree.frameTree.frame.id;
  // Crash detection for the recorded tab.
  await chrome.debugger.sendCommand(target, 'Inspector.enable').catch(() => {});
  // Interaction capture: binding + hook for future documents and the current one.
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Runtime.addBinding', { name: INTERACTION_BINDING });
  await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
    source: INTERACTION_HOOK_SOURCE,
  });
  await chrome.debugger
    .sendCommand(target, 'Runtime.evaluate', { expression: INTERACTION_HOOK_SOURCE })
    .catch(() => {});
  // Pixel-change detection: non-fatal if unavailable — navigation triggers
  // still work.
  try {
    await chrome.debugger.sendCommand(target, 'Page.startScreencast', SCREENCAST_OPTS);
  } catch (e) {
    if (session) postError(session.port, `Pixel-change detection unavailable: ${e.message}`);
  }
}

/**
 * The tab's debug target closed but the tab may still be alive: prerender or
 * back/forward-cache activation, process swap — or another extension (e.g. a
 * password manager) injecting a frame Chrome won't let us debug, which
 * force-detaches our session. Re-attach and continue the SAME session.
 */
async function attemptReattach() {
  if (!session || session.reattaching) return;
  session.reattaching = true;
  const { tabId, port } = session;

  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    if (!session || session.tabId !== tabId) return; // stopped meanwhile
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break; // tab really closed; tabs.onRemoved handles the session
    if (!/^https?:/.test(tab.url || '')) continue; // mid-navigation, retry
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await enableDomains({ tabId });
      if (!session || session.tabId !== tabId) return;
      // In-flight requests of the old target are gone; their metadata was
      // already emitted or is unrecoverable.
      session.pending.clear();
      session.prevFrame = null;
      session.reattaching = false;
      postLog(port, 'Debugger re-attached after target swap — recording continues.');
      return;
    } catch {
      // Attach not possible yet (e.g. injected frame still present) — retry.
    }
  }

  if (session && session.tabId === tabId) {
    session.reattaching = false;
    endSession(STOP_REASONS.DEBUGGER_DETACHED, { detach: false, detail: 'target_closed' });
  }
}

function pauseSession() {
  if (!session || session.paused || session.reattaching) return;
  session.paused = true;
  if (session.autoTimer) {
    clearTimeout(session.autoTimer);
    session.autoTimer = null;
  }
  session.autoPendingSince = null;
  // In-flight requests will never finish once detached.
  session.pending.clear();
  // Full detach: the debugger infobar disappears and nothing is captured.
  chrome.debugger.detach({ tabId: session.tabId }).catch(() => {});
  session.port.postMessage({
    type: MSG.PAUSED,
    seq: ++session.seq,
    ts: new Date().toISOString(),
  });
}

async function resumeSession() {
  if (!session || !session.paused) return;
  const { tabId, port } = session;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await enableDomains({ tabId });
  } catch (e) {
    postError(port, `Could not resume: ${e.message}`);
    return;
  }
  if (!session || session.tabId !== tabId) return;
  session.paused = false;
  session.prevFrame = null;
  port.postMessage({
    type: MSG.RESUMED,
    seq: ++session.seq,
    ts: new Date().toISOString(),
  });
}

function endSession(reason, { detach = true, detail = null } = {}) {
  if (!session) return;
  const { port, tabId } = session;
  if (session.autoTimer) clearTimeout(session.autoTimer);
  clearInterval(session.keepAliveTimer);
  session = null;
  if (detach) chrome.debugger.detach({ tabId }).catch(() => {});
  try {
    port.postMessage({ type: MSG.STOPPED, reason, detail, endedAt: new Date().toISOString() });
  } catch {
    // Port already gone.
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!session || source.tabId !== session.tabId) return;
  if (reason === 'target_closed') {
    // Target swap (prerender/BFCache/process change) or a foreign-extension
    // frame (password manager) — try to continue the same session.
    attemptReattach();
    return;
  }
  // "canceled_by_user": infobar cancel or DevTools took over — intentional.
  endSession(STOP_REASONS.DEBUGGER_DETACHED, { detach: false, detail: reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && session.tabId === tabId) {
    endSession(STOP_REASONS.TAB_CLOSED, { detach: false });
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!session || source.tabId !== session.tabId) return;
  switch (method) {
    case 'Network.requestWillBeSent':
      onRequestWillBeSent(params);
      break;
    case 'Network.responseReceived': {
      const entry = session.pending.get(params.requestId);
      if (entry) entry.response = params.response;
      break;
    }
    case 'Network.requestServedFromCache': {
      const entry = session.pending.get(params.requestId);
      if (entry) entry.servedFromCache = true;
      break;
    }
    case 'Network.loadingFinished':
      onLoadingFinished(params);
      break;
    case 'Network.loadingFailed':
      onLoadingFailed(params);
      break;
    case 'Page.frameNavigated': {
      const isMainFrame = !params.frame.parentId;
      if (isMainFrame) session.mainFrameId = params.frame.id;
      emitNavEvent({
        event: 'frameNavigated',
        url: params.frame.url,
        frameId: params.frame.id,
        isMainFrame,
      });
      break;
    }
    case 'Page.navigatedWithinDocument': {
      // SPA route change (history API / hash navigation).
      const isMainFrame = params.frameId === session.mainFrameId;
      emitNavEvent({
        event: 'navigatedWithinDocument',
        url: params.url,
        frameId: params.frameId,
        isMainFrame,
      });
      if (isMainFrame) scheduleAutoScreenshot('auto:spa-route');
      break;
    }
    case 'Page.loadEventFired':
      emitNavEvent({ event: 'loadEventFired' });
      scheduleAutoScreenshot('auto:navigation');
      break;
    case 'Page.domContentEventFired':
      emitNavEvent({ event: 'domContentEventFired' });
      break;
    case 'Page.screencastFrame':
      onScreencastFrame(params);
      break;
    case 'Runtime.bindingCalled':
      if (params.name === INTERACTION_BINDING) onUserEvent(params.payload);
      break;
    case 'Inspector.targetCrashed':
      endSession(STOP_REASONS.TAB_CRASHED, { detach: false });
      break;
  }
});

function onRequestWillBeSent(params) {
  const { requestId, request, wallTime, timestamp, redirectResponse, type, initiator } = params;
  const previous = session.pending.get(requestId);
  let redirectChain = [];

  if (redirectResponse && previous) {
    // Emit the completed redirect hop; redirect responses carry no body.
    previous.response = redirectResponse;
    emitRequestComplete(previous, { bodySkipped: 'redirect' });
    redirectChain = [...previous.redirectChain, previous.request.url];
  }

  session.pending.set(requestId, {
    requestId,
    request,
    wallTime,
    timestamp,
    resourceType: type,
    initiator,
    frameId: params.frameId,
    redirectChain,
    servedFromCache: false,
    response: null,
  });
}

async function onLoadingFinished(params) {
  const entry = session?.pending.get(params.requestId);
  if (!entry) return;
  session.pending.delete(params.requestId);
  entry.finishedTimestamp = params.timestamp;
  entry.encodedDataLength = params.encodedDataLength;

  // Chrome omits inline postData for larger request bodies; fetch it
  // explicitly so submitted form/JSON payloads are always recorded.
  if (entry.request.hasPostData && !entry.request.postData && session) {
    try {
      const r = await chrome.debugger.sendCommand(
        { tabId: session.tabId },
        'Network.getRequestPostData',
        { requestId: params.requestId }
      );
      entry.request.postData = r.postData;
    } catch {
      // Body no longer retained; request metadata is still recorded.
    }
  }
  if (!session) return;

  const url = entry.request.url || '';
  let body = null;
  let bodySkipped;
  let bodyError;

  if (SKIP_SCHEMES.some((s) => url.startsWith(s))) {
    bodySkipped = 'scheme';
  } else if (SKIP_RESOURCE_TYPES.has(entry.resourceType)) {
    bodySkipped = `resourceType:${entry.resourceType}`;
  } else if (params.encodedDataLength > BODY_CAP_BYTES) {
    bodySkipped = 'size';
  } else {
    // Fetch the body immediately: CDP evicts bodies on navigation and when
    // its buffer fills, so this must not be deferred.
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: session.tabId },
        'Network.getResponseBody',
        { requestId: params.requestId }
      );
      body = { data: result.body, base64Encoded: !!result.base64Encoded };
    } catch (e) {
      bodyError = e.message || 'evicted';
    }
  }

  if (!session) return; // session ended while awaiting the body
  emitRequestComplete(entry, { body, bodySkipped, bodyError });
}

function onLoadingFailed(params) {
  const entry = session.pending.get(params.requestId);
  if (!entry) return;
  session.pending.delete(params.requestId);
  entry.finishedTimestamp = params.timestamp;
  emitRequestComplete(entry, {
    failed: { errorText: params.errorText, canceled: !!params.canceled },
  });
}

function emitRequestComplete(entry, { body = null, bodySkipped, bodyError, failed } = {}) {
  if (!session) return;
  const r = entry.response;
  const durationMs =
    entry.finishedTimestamp != null && entry.timestamp != null
      ? Math.round((entry.finishedTimestamp - entry.timestamp) * 1000)
      : null;

  session.port.postMessage({
    type: MSG.REQUEST_COMPLETE,
    seq: ++session.seq,
    ts: new Date().toISOString(),
    request: {
      url: entry.request.url,
      method: entry.request.method,
      headers: entry.request.headers,
      postData: entry.request.postData,
      resourceType: entry.resourceType,
      initiator: entry.initiator,
      redirectChain: entry.redirectChain,
    },
    response: r
      ? {
          status: r.status,
          statusText: r.statusText,
          headers: r.headers,
          mimeType: r.mimeType,
          remoteIPAddress: r.remoteIPAddress,
          protocol: r.protocol,
          fromDiskCache: !!r.fromDiskCache,
          fromServiceWorker: !!r.fromServiceWorker,
          servedFromCache: entry.servedFromCache,
          encodedDataLength: entry.encodedDataLength,
        }
      : null,
    failed,
    timing: {
      startedAt: entry.wallTime ? new Date(entry.wallTime * 1000).toISOString() : null,
      durationMs,
    },
    body,
    bodySkipped,
    bodyError,
    isMainDocument:
      entry.resourceType === 'Document' && entry.frameId === session.mainFrameId,
  });
}

function onUserEvent(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return;
  }
  session.port.postMessage({
    type: MSG.USER_EVENT,
    seq: ++session.seq,
    ts: new Date().toISOString(),
    ...data,
  });
}

function emitNavEvent(fields) {
  session.port.postMessage({
    type: MSG.NAV_EVENT,
    seq: ++session.seq,
    ts: new Date().toISOString(),
    ...fields,
  });
}

async function onScreencastFrame(params) {
  // Always ack, or Chrome stops sending frames.
  chrome.debugger
    .sendCommand({ tabId: session.tabId }, 'Page.screencastFrameAck', {
      sessionId: params.sessionId,
    })
    .catch(() => {});

  if (!session.autoScreenshot || session.diffBusy) return; // drop frames while busy
  session.diffBusy = true;
  try {
    const bytes = Uint8Array.from(atob(params.data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (!diffCanvas) {
      diffCanvas = new OffscreenCanvas(DIFF_SIZE, DIFF_SIZE);
      diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
    }
    diffCtx.drawImage(bitmap, 0, 0, DIFF_SIZE, DIFF_SIZE);
    bitmap.close();
    const frame = diffCtx.getImageData(0, 0, DIFF_SIZE, DIFF_SIZE).data;

    if (session?.prevFrame) {
      const prev = session.prevFrame;
      let changed = 0;
      for (let i = 0; i < frame.length; i += 4) {
        const delta =
          Math.abs(frame[i] - prev[i]) +
          Math.abs(frame[i + 1] - prev[i + 1]) +
          Math.abs(frame[i + 2] - prev[i + 2]);
        if (delta > DIFF_PIXEL_DELTA) changed++;
      }
      const changedPct = (changed / (DIFF_SIZE * DIFF_SIZE)) * 100;
      if (changedPct >= session.cfg.pixelDiffPct) {
        scheduleAutoScreenshot('auto:view-change');
      }
    }
    if (session) session.prevFrame = frame;
  } catch {
    // Undecodable frame; skip it.
  } finally {
    if (session) session.diffBusy = false;
  }
}

function scheduleAutoScreenshot(trigger) {
  if (!session?.autoScreenshot) return;
  const { settleMs, minIntervalMs } = session.cfg;
  const now = Date.now();
  // Wait for the view to settle, but never fire two auto shots closer together
  // than minIntervalMs; a later trigger replaces a pending one. Under
  // CONTINUOUS change (long scrolls, animations) plain debouncing would defer
  // forever, so once a shot has been pending for 2× minIntervalMs, fire now.
  if (!session.autoPendingSince) session.autoPendingSince = now;
  const overdue = now - session.autoPendingSince >= minIntervalMs * 2;
  const wait = overdue ? 0 : Math.max(settleMs, session.lastAutoShotAt + minIntervalMs - now);
  if (session.autoTimer) clearTimeout(session.autoTimer);
  session.autoTimer = setTimeout(() => {
    if (!session) return;
    session.autoTimer = null;
    session.autoPendingSince = null;
    session.lastAutoShotAt = Date.now();
    takeScreenshot(trigger);
  }, wait);
}

async function takeScreenshot(trigger) {
  if (!session || session.reattaching || session.paused) return;
  const { port, tabId } = session;
  try {
    const { data } = await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      { format: 'png' }
    );
    if (!session) return;

    // Snapshot the RENDERED DOM at this moment. For SPAs (React/Angular/…)
    // the network-captured HTML is only the initial shell; this is the state
    // the framework actually built. Throttled for auto shots to keep bursts
    // (e.g. while typing) lightweight.
    let dom = null;
    const wantDom =
      trigger === 'manual' || Date.now() - session.lastDomAt >= DOM_SNAPSHOT_MIN_INTERVAL_MS;
    if (wantDom) {
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
          returnByValue: true,
        });
        if (result.result?.value) dom = '<!DOCTYPE html>\n' + result.result.value;
        if (dom && dom.length > DOM_SNAPSHOT_CAP_CHARS) dom = null; // keep the shot, drop the DOM
        if (dom && session) session.lastDomAt = Date.now();
      } catch {
        // Screenshot is still worth keeping without the DOM snapshot.
      }
    }
    if (!session) return;

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!session) return; // session ended while fetching tab info
    port.postMessage({
      type: MSG.SCREENSHOT_DATA,
      seq: ++session.seq,
      ts: new Date().toISOString(),
      base64: data,
      dom,
      trigger,
      pageUrl: tab?.url ?? null,
      pageTitle: tab?.title ?? null,
    });
  } catch (e) {
    postError(port, `Screenshot failed (${trigger}): ${e.message}`);
  }
}

function postError(port, message) {
  try {
    port.postMessage({ type: MSG.ERROR, ts: new Date().toISOString(), message });
  } catch {
    // Port already gone.
  }
}

function postLog(port, message) {
  try {
    port.postMessage({ type: MSG.LOG, ts: new Date().toISOString(), message });
  } catch {
    // Port already gone.
  }
}
