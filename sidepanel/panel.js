// Side panel controller: session state machine, folder picking, and dispatch
// of records streamed from the service worker into the SessionWriter.

import { MSG, PORT_NAME, STOP_REASONS, SESSION_FORMAT_VERSION } from '../shared/protocol.js';
import { sessionFolderName } from '../shared/mime.js';
import { SessionWriter, QUEUE_WARN_DEPTH } from './writer.js';

const el = {
  status: document.getElementById('status'),
  tabSelect: document.getElementById('tab-select'),
  refreshTabs: document.getElementById('refresh-tabs'),
  sessionName: document.getElementById('session-name'),
  sessionNote: document.getElementById('session-note'),
  start: document.getElementById('start'),
  resumeExisting: document.getElementById('resume-existing'),
  pause: document.getElementById('pause'),
  stop: document.getElementById('stop'),
  sessionFolder: document.getElementById('session-folder'),
  previewDetails: document.getElementById('preview-details'),
  screenshot: document.getElementById('screenshot'),
  countRequests: document.getElementById('count-requests'),
  countScreenshots: document.getElementById('count-screenshots'),
  countBytes: document.getElementById('count-bytes'),
  errorBanner: document.getElementById('error-banner'),
  log: document.getElementById('log'),
  sensitivity: document.getElementById('sensitivity'),
  shotPreview: document.getElementById('shot-preview'),
  shotImg: document.getElementById('shot-img'),
  shotCaption: document.getElementById('shot-caption'),
  openViewer: document.getElementById('open-viewer'),
};

// idle | picking-folder | starting | recording | paused | stopping
let state = 'idle';
let port = null;
let writer = null;
let sessionMeta = null;
let totals = null;
let stopReasonOverride = null;
let queueWarned = false;
// Last captured main-frame HTML document; linked from screenshot metadata.
let lastDocument = null;
// Open WebSocket/SSE streams: key -> { kind, url, files, counters }.
let liveStreams = new Map();
// MV3 service workers are killed after ~30s without events; during quiet
// phases (user typing, no traffic) that would detach the debugger and kill
// the session. Ping well inside that window while recording.
let pingTimer = null;
const PING_INTERVAL_MS = 15_000;
// Kept across sessions (target folder and tab of the last recording).
let rootHandle = null;
let currentTabId = null;
// Default session name (recorded tab's host) when the user types none.
let pendingDefaultName = null;
// State read from disk for "Resume existing" — set right before a resume
// (folder handle, last seq, prior metadata/totals).
let resumeData = null;
// Highest seq seen in the current session; passed back on continue.
let maxSeq = 0;
// bytesWritten carried over from earlier parts of a continued session.
let baseBytesWritten = 0;
// True while the running session is a continuation of an earlier one.
let resuming = false;

setState('idle');
refreshTabs();
el.sensitivity.value = localStorage.getItem('sensitivity') || 'fluent';
el.refreshTabs.addEventListener('click', refreshTabs);
el.tabSelect.addEventListener('change', updateNamePlaceholder);
el.start.addEventListener('click', onStart);
el.resumeExisting.addEventListener('click', onResumeExisting);
el.pause.addEventListener('click', onPauseToggle);
el.stop.addEventListener('click', onStop);
el.screenshot.addEventListener('click', onScreenshot);
el.sensitivity.addEventListener('change', () => {
  localStorage.setItem('sensitivity', el.sensitivity.value);
  if (state === 'recording') {
    port.postMessage({
      type: MSG.SET_AUTO_SCREENSHOT,
      enabled: el.sensitivity.value !== 'off',
      sensitivity: el.sensitivity.value,
    });
    logLine(`Auto-screenshot: ${el.sensitivity.value}`, 'event');
  }
});
el.openViewer.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
});
el.shotImg.addEventListener('click', () => {
  if (lastShotUrl) window.open(lastShotUrl, '_blank');
});

function setState(next) {
  state = next;
  const labels = {
    idle: ['Idle', 'idle'],
    'picking-folder': ['Choose folder…', 'busy'],
    starting: ['Starting…', 'busy'],
    recording: ['Recording', 'recording'],
    paused: ['Paused', 'busy'],
    stopping: ['Stopping…', 'busy'],
  };
  const [text, cls] = labels[next];
  el.status.textContent = text;
  el.status.className = `badge ${cls}`;

  const recording = next === 'recording';
  const paused = next === 'paused';
  const idle = next === 'idle';
  el.start.hidden = !idle;
  el.resumeExisting.hidden = !idle;
  el.pause.hidden = idle;
  el.pause.disabled = !(recording || paused);
  el.pause.textContent = paused ? '▶ Resume' : '⏸ Pause';
  el.stop.hidden = idle;
  el.stop.disabled = !(recording || paused);
  el.screenshot.disabled = !recording;
  el.tabSelect.disabled = !idle;
  el.refreshTabs.disabled = !idle;
  el.sessionName.disabled = !idle;
  el.sessionNote.disabled = !idle;
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const previous = el.tabSelect.value;
  el.tabSelect.innerHTML = '';
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = `${tab.title || tab.url}`;
    option.title = tab.url;
    option.dataset.url = tab.url;
    el.tabSelect.appendChild(option);
  }
  // Keep the user's pick if that tab still qualifies; otherwise the active tab.
  const keep = tabs.find((t) => String(t.id) === previous) ??
    (active && tabs.find((t) => t.id === active.id));
  if (keep) el.tabSelect.value = String(keep.id);
  el.start.disabled = tabs.length === 0;
  if (tabs.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No http(s) tabs open';
    el.tabSelect.appendChild(option);
  }
  updateNamePlaceholder();
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** The selected tab's host is the default session name; show it as placeholder. */
function updateNamePlaceholder() {
  const url = el.tabSelect.selectedOptions[0]?.dataset.url;
  const host = url ? hostFromUrl(url) : null;
  el.sessionName.placeholder = host ? `Session name (default: ${host})` : 'Session name';
}

// The dropdown goes stale when tabs navigate away or close — keep it fresh
// while idle so Start never targets a tab we can no longer record.
for (const event of [chrome.tabs.onUpdated, chrome.tabs.onRemoved, chrome.tabs.onCreated]) {
  event.addListener(() => {
    if (state === 'idle') refreshTabs();
  });
}

async function validateSelectedTab() {
  const tabId = Number(el.tabSelect.value);
  if (!tabId) return null;
  // The dropdown can be stale (tab closed or navigated to a non-http page,
  // e.g. another extension's viewer) — verify before attaching.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || '')) {
    showError('The selected tab is gone or no longer shows an http(s) page — pick another tab.');
    await refreshTabs();
    return null;
  }
  return tabId;
}

async function onStart() {
  hideError();
  clearCrashBadge();
  const tabId = await validateSelectedTab();
  if (!tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  pendingDefaultName = tab ? hostFromUrl(tab.url) : null;

  setState('picking-folder');
  try {
    rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    setState('idle'); // user cancelled the picker
    return;
  }
  await startRecordingSession(tabId, { resume: false });
}

async function onResumeExisting() {
  hideError();
  clearCrashBadge();
  const tabId = await validateSelectedTab();
  if (!tabId) return;

  setState('picking-folder');
  let picked;
  try {
    picked = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    setState('idle');
    return;
  }

  // Accept the session folder itself, or a root folder — then resume the
  // newest valid session inside it.
  let candidates = [];
  if (await hasFile(picked, 'events.jsonl')) {
    candidates = [picked];
  } else {
    for await (const entry of picked.values()) {
      if (entry.kind === 'directory' && (await hasFile(entry, 'events.jsonl'))) {
        candidates.push(entry);
      }
    }
    candidates.sort((a, b) => b.name.localeCompare(a.name)); // newest first
  }
  if (candidates.length === 0) {
    showError('Not a session folder: no events.jsonl found here or in any subfolder.');
    setState('idle');
    return;
  }

  const validation = await validateSessionFolder(candidates[0]);
  if (!validation.ok) {
    showError(`Cannot resume ${candidates[0].name}: ${validation.error}`);
    setState('idle');
    return;
  }

  resumeData = validation;
  logLine(`Resuming session folder ${candidates[0].name} (from seq ${validation.lastSeq})`, 'event');
  await startRecordingSession(tabId, { resume: true });
}

async function hasFile(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a folder is a resumable session recorded in the CURRENT format:
 * events.jsonl present with a parseable last event, session.json present and
 * carrying a matching formatVersion.
 */
async function validateSessionFolder(dirHandle) {
  let meta;
  try {
    const file = await (await dirHandle.getFileHandle('session.json')).getFile();
    meta = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'session.json is missing or unreadable (aborted or foreign folder).' };
  }
  if (meta.formatVersion !== SESSION_FORMAT_VERSION) {
    return {
      ok: false,
      error: `format version ${meta.formatVersion ?? 'pre-1 (older extension)'} does not match ` +
        `the current version ${SESSION_FORMAT_VERSION}.`,
    };
  }

  let lastSeq = 0;
  try {
    const file = await (await dirHandle.getFileHandle('events.jsonl')).getFile();
    const tail = await file.slice(Math.max(0, file.size - 65536)).text();
    const lines = tail.split('\n').filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (typeof obj.seq === 'number') {
          lastSeq = obj.seq;
          break;
        }
      } catch {
        // partial line at the slice boundary — keep scanning backwards
      }
    }
  } catch {
    return { ok: false, error: 'events.jsonl is unreadable.' };
  }

  const t = meta.totals || {};
  return {
    ok: true,
    dirHandle,
    folderName: dirHandle.name,
    meta,
    lastSeq,
    totals: {
      requests: t.requests || 0,
      screenshots: t.screenshots || 0,
      navigations: t.navigations || 0,
      skippedBodies: t.skippedBodies || 0,
      failedRequests: t.failedRequests || 0,
    },
    bytesWritten: t.bytesWritten || 0,
  };
}

/** Start a session — fresh folder under rootHandle, or an existing folder on resume. */
async function startRecordingSession(tabId, { resume }) {
  setState('starting');
  currentTabId = tabId;
  resuming = resume;
  try {
    writer = new SessionWriter(rootHandle, onWriteError);
    if (resume) {
      await writer.initFromHandle(resumeData.dirHandle);
    } else {
      await writer.init(sessionFolderName(el.sessionName.value.trim() || pendingDefaultName));
    }
  } catch (e) {
    writer = null;
    showError(`Could not open session folder: ${e.message}`);
    setState('idle');
    return;
  }
  const folderName = writer.folderName;

  if (resume) {
    totals = { ...resumeData.totals };
    maxSeq = resumeData.lastSeq;
    baseBytesWritten = resumeData.bytesWritten;
  } else {
    totals = { requests: 0, screenshots: 0, navigations: 0, skippedBodies: 0, failedRequests: 0 };
    maxSeq = 0;
    baseBytesWritten = 0;
    // Make the session folder self-describing: bundle the analysis guide so
    // the recording can be handed to an AI (or a colleague) as-is.
    fetch(chrome.runtime.getURL('SESSION_FORMAT.md'))
      .then((r) => r.text())
      .then((text) => writer?.writeExtra('SESSION_FORMAT.md', text))
      .catch(() => {});
  }
  stopReasonOverride = null;
  queueWarned = false;
  lastDocument = null;
  liveStreams = new Map();

  el.sessionFolder.textContent = `📁 ${folderName}`;
  el.sessionFolder.title = folderName;
  el.sessionFolder.hidden = false;
  el.previewDetails.hidden = true;
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onPortDisconnect);
  port.postMessage({
    type: MSG.START,
    tabId,
    autoScreenshot: el.sensitivity.value !== 'off',
    sensitivity: el.sensitivity.value,
    startSeq: resume ? resumeData.lastSeq : 0,
  });
}

function onStop() {
  if (state !== 'recording' && state !== 'paused') return;
  setState('stopping');
  port.postMessage({ type: MSG.STOP });
}

function onPauseToggle() {
  if (state === 'recording') {
    el.pause.disabled = true; // until PAUSED arrives
    port.postMessage({ type: MSG.PAUSE });
  } else if (state === 'paused') {
    el.pause.disabled = true; // until RESUMED (or error) arrives
    port.postMessage({ type: MSG.RESUME });
  }
}

function onScreenshot() {
  if (state !== 'recording') return;
  el.screenshot.disabled = true;
  port.postMessage({ type: MSG.SCREENSHOT });
}

function onMessage(msg) {
  if (typeof msg.seq === 'number') maxSeq = Math.max(maxSeq, msg.seq);
  switch (msg.type) {
    case MSG.STARTED:
      onStarted(msg);
      break;
    case MSG.REQUEST_COMPLETE:
      onRequestComplete(msg);
      break;
    case MSG.NAV_EVENT:
      onNavEvent(msg);
      break;
    case MSG.USER_EVENT:
      onUserEvent(msg);
      break;
    case MSG.WS_OPEN: {
      const key = `ws:${msg.wsId}`;
      const files = writer.openStream(key, 'WS', msg.seq, msg.ts, msg.url);
      liveStreams.set(key, {
        kind: 'ws', url: msg.url, openedAt: msg.ts, sent: 0, received: 0, truncated: 0, ...files,
      });
      writer.appendEvent({
        seq: msg.seq, ts: msg.ts, type: 'websocket', event: 'opened',
        url: msg.url, streamFile: files.streamFile, metaFile: files.metaFile,
      });
      logLine(`WS opened: ${msg.url}`, 'event');
      break;
    }
    case MSG.WS_FRAME: {
      const stream = liveStreams.get(`ws:${msg.wsId}`);
      if (!stream) break;
      if (msg.dir === 'sent') stream.sent++;
      else stream.received++;
      if (msg.truncated) stream.truncated++;
      writer.appendStreamLine(`ws:${msg.wsId}`, {
        ts: msg.ts, dir: msg.dir, opcode: msg.opcode,
        truncated: msg.truncated || undefined, payload: msg.payload,
      });
      break;
    }
    case MSG.WS_CLOSE: {
      const key = `ws:${msg.wsId}`;
      const stream = liveStreams.get(key);
      if (!stream) break;
      liveStreams.delete(key);
      writer.closeStream(key, {
        url: stream.url, openedAt: stream.openedAt, closedAt: msg.ts,
        framesSent: msg.framesSent, framesReceived: msg.framesReceived,
        droppedFrames: msg.droppedFrames, truncatedFrames: msg.truncatedFrames,
        streamFile: stream.streamFile,
      });
      writer.appendEvent({
        seq: msg.seq, ts: msg.ts, type: 'websocket', event: 'closed', url: stream.url,
        framesSent: msg.framesSent, framesReceived: msg.framesReceived,
        streamFile: stream.streamFile, metaFile: stream.metaFile,
      });
      logLine(`WS closed: ${stream.url} (${msg.framesSent}↑ ${msg.framesReceived}↓)`, 'event');
      break;
    }
    case MSG.SSE_MESSAGE: {
      const key = `sse:${msg.sseId}`;
      let stream = liveStreams.get(key);
      if (!stream) {
        const files = writer.openStream(key, 'SSE', msg.seq, msg.ts, msg.url);
        stream = {
          kind: 'sse', url: msg.url, openedAt: msg.ts, messages: 0, truncated: 0, ...files,
        };
        liveStreams.set(key, stream);
        writer.appendEvent({
          seq: msg.seq, ts: msg.ts, type: 'sse', event: 'opened',
          url: msg.url, streamFile: files.streamFile, metaFile: files.metaFile,
        });
        logLine(`SSE stream: ${msg.url ?? '(unknown URL)'}`, 'event');
      }
      stream.messages++;
      if (msg.truncated) stream.truncated++;
      writer.appendStreamLine(key, {
        ts: msg.ts, eventName: msg.eventName, eventId: msg.eventId,
        truncated: msg.truncated || undefined, data: msg.data,
      });
      break;
    }
    case MSG.PAUSED:
      writer.appendEvent({ seq: msg.seq, ts: msg.ts, type: 'pause' });
      logLine('Recording paused (debugger released)', 'event');
      setState('paused');
      break;
    case MSG.RESUMED:
      writer.appendEvent({ seq: msg.seq, ts: msg.ts, type: 'resume' });
      logLine('Recording resumed', 'event');
      setState('recording');
      break;
    case MSG.SCREENSHOT_DATA:
      onScreenshotData(msg);
      break;
    case MSG.STOPPED:
      finalizeSession(stopReasonOverride || msg.reason, msg.endedAt, msg.detail);
      break;
    case MSG.LOG:
      logLine(msg.message);
      break;
    case MSG.ERROR:
      logLine(msg.message, 'error');
      if (state === 'starting') {
        // Attach failed; nothing was recorded.
        showError(msg.message);
        cleanupPort();
        writer = null;
        setState('idle');
      } else if (state === 'recording') {
        el.screenshot.disabled = false; // screenshot failures re-enable the button
      } else if (state === 'paused') {
        el.pause.disabled = false; // resume failed — allow retrying
      }
      break;
  }
}

function onStarted(msg) {
  if (resuming) {
    sessionMeta = resumeData.meta;
    sessionMeta.endedAt = null;
    sessionMeta.stopReason = null;
    sessionMeta.stopDetail = null;
    sessionMeta.startedAt ??= msg.startedAt;
    sessionMeta.startUrl ??= msg.tabUrl;
    (sessionMeta.resumedAt ??= []).push(msg.startedAt);
  } else {
    const uaMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    sessionMeta = {
      formatVersion: SESSION_FORMAT_VERSION,
      name: el.sessionName.value.trim() || pendingDefaultName,
      note: el.sessionNote.value.trim() || null,
      startedAt: msg.startedAt,
      endedAt: null,
      stopReason: null,
      startUrl: msg.tabUrl,
      tabTitle: msg.tabTitle,
      userAgent: navigator.userAgent,
      chromeVersion: uaMatch ? uaMatch[1] : null,
      viewport: msg.viewport,
      extensionVersion: chrome.runtime.getManifest().version,
      bodyCapBytes: msg.bodyCapBytes,
      autoScreenshot: el.sensitivity.value !== 'off',
      sensitivity: el.sensitivity.value,
      totals: null,
    };
  }
  writer.writeSessionJson(sessionMeta);
  setState('recording');
  pingTimer = setInterval(() => {
    try {
      port?.postMessage({ type: MSG.PING });
    } catch {
      // Port gone; disconnect handling takes over.
    }
  }, PING_INTERVAL_MS);
  logLine(
    resuming
      ? `Recording continued in ${writer.folderName} (from seq ${maxSeq})`
      : `Recording started: ${msg.tabUrl}`,
    'event'
  );
}

function onRequestComplete(msg) {
  totals.requests++;
  if (msg.bodySkipped) totals.skippedBodies++;
  if (msg.failed) totals.failedRequests++;

  const files = writer.writeRequestRecord(msg);
  if (msg.isMainDocument && files.bodyFile) {
    lastDocument = { url: msg.request.url, file: files.bodyFile, seq: msg.seq };
  }
  writer.appendEvent({
    seq: msg.seq,
    ts: msg.ts,
    type: 'request',
    method: msg.request.method,
    url: msg.request.url,
    status: msg.response?.status ?? null,
    mimeType: msg.response?.mimeType ?? null,
    failed: msg.failed?.errorText,
    bodyFile: files.bodyFile,
    metaFile: files.metaFile,
    size: files.bodySize,
  });

  const status = msg.failed ? `FAILED (${msg.failed.errorText})` : msg.response?.status ?? '?';
  logLine(`${msg.request.method} ${status} ${msg.request.url}`);
  updateCounters();
  warnIfBacklogged();
}

function onNavEvent(msg) {
  const isNavigation = msg.event === 'frameNavigated' || msg.event === 'navigatedWithinDocument';
  writer.appendEvent({
    seq: msg.seq,
    ts: msg.ts,
    type: isNavigation ? 'navigation' : 'pageLoad',
    event: msg.event,
    url: msg.url,
    frameId: msg.frameId,
    isMainFrame: msg.isMainFrame,
  });
  if (isNavigation && msg.isMainFrame) {
    totals.navigations++;
    logLine(`Navigated: ${msg.url}`, 'event');
  }
}

function onUserEvent(msg) {
  writer.appendEvent({
    seq: msg.seq,
    ts: msg.ts,
    type: 'interaction',
    kind: msg.kind,
    x: msg.x,
    y: msg.y,
    target: msg.target,
    form: msg.form,
    value: msg.value,
    checked: msg.checked,
    key: msg.key,
  });
  const what = msg.target?.text || msg.target?.label || msg.target?.selector || '';
  logLine(`${msg.kind}${msg.key ? ` ${msg.key}` : ''}: ${what}`);
}

function onScreenshotData(msg) {
  totals.screenshots++;
  const files = writer.writeScreenshot(msg, lastDocument);
  writer.appendEvent({
    seq: msg.seq,
    ts: msg.ts,
    type: 'screenshot',
    trigger: msg.trigger,
    pageUrl: msg.pageUrl,
    file: files.file,
    metaFile: files.metaFile,
    domFile: files.domFile,
    documentFile: lastDocument?.file ?? null,
  });
  showShotPreview(msg);
  logLine(`Screenshot #${totals.screenshots} saved (${msg.trigger})`, 'event');
  if (msg.trigger === 'manual') el.screenshot.disabled = false;
  updateCounters();
}

let lastShotUrl = null;

function showShotPreview(msg) {
  // Blob URL instead of data URL so the preview can open full-size in a tab.
  const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
  if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
  lastShotUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  el.shotImg.src = lastShotUrl;
  el.shotCaption.textContent =
    `#${totals.screenshots} · ${msg.trigger} · ${new Date(msg.ts).toLocaleTimeString()} — click to enlarge`;
  el.previewDetails.hidden = false;
  // Restart the flash animation even when it is still running.
  el.shotPreview.classList.remove('flash');
  void el.shotPreview.offsetWidth;
  el.shotPreview.classList.add('flash');
}

async function finalizeSession(reason, endedAt, detail = null) {
  setState('stopping');
  cleanupPort();

  if (writer && sessionMeta) {
    // Streams still open at stop get their metadata written too.
    for (const [key, stream] of liveStreams) {
      writer.closeStream(key, {
        url: stream.url, openedAt: stream.openedAt, closedAt: null, openAtStop: true,
        framesSent: stream.sent, framesReceived: stream.received,
        messages: stream.messages, truncatedFrames: stream.truncated,
        streamFile: stream.streamFile,
      });
    }
    liveStreams.clear();
    const bytesWritten = baseBytesWritten + writer.bytesWritten;
    sessionMeta.endedAt = endedAt || new Date().toISOString();
    sessionMeta.stopReason = reason;
    sessionMeta.stopDetail = detail;
    sessionMeta.totals = { ...totals, bytesWritten };
    writer.appendLog('info',
      `session ended: reason=${reason}${detail ? ` detail=${detail}` : ''} ` +
      `requests=${totals.requests} screenshots=${totals.screenshots}`);
    writer.writeSessionJson(sessionMeta);
    try {
      await writer.finalize();
      logLine(`Session saved (${reason}): ${totals.requests} requests, ` +
        `${totals.screenshots} screenshots, ${formatBytes(bytesWritten)}`, 'event');
    } catch (e) {
      showError(`Error while finishing writes: ${e.message}`);
    }
  }

  writer = null;
  sessionMeta = null;
  setState('idle');
  alertIfUnexpected(reason, detail);
}

/**
 * Alert (banner + toolbar badge) when a session died without the user asking
 * for it. Recording is NOT restarted automatically — press Start to record
 * again; the crash reason is in the panel log and in the session folder's
 * session.log / session.json for later analysis.
 */
function alertIfUnexpected(reason, detail) {
  const unexpected =
    reason === STOP_REASONS.DISCONNECTED ||
    reason === STOP_REASONS.TAB_CRASHED ||
    (reason === STOP_REASONS.DEBUGGER_DETACHED && detail !== 'canceled_by_user');
  if (!unexpected) return;
  const message = `Recording stopped unexpectedly (${reason}${detail ? `: ${detail}` : ''}).`;
  showError(`⚠ ${message} See session.log in the session folder. Press Start to record again.`);
  logLine(message, 'error');
  // Badge on the toolbar icon so the crash is visible even if the panel is not.
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: '!' });
}

function clearCrashBadge() {
  chrome.action.setBadgeText({ text: '' });
}

function onPortDisconnect() {
  // Service worker went away unexpectedly while we still hold a session.
  if (state === 'recording' || state === 'starting') {
    port = null;
    finalizeSession(STOP_REASONS.DISCONNECTED, null);
  }
}

function onWriteError(err) {
  console.error('Write error', err);
  if (state === 'recording') {
    showError(`Write error: ${err.message} — stopping session.`);
    stopReasonOverride = STOP_REASONS.WRITE_ERROR;
    setState('stopping');
    port.postMessage({ type: MSG.STOP });
  } else {
    logLine(`Write error: ${err.message}`, 'error');
  }
}

function cleanupPort() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (port) {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onPortDisconnect);
    try {
      port.disconnect();
    } catch {
      // already disconnected
    }
    port = null;
  }
}

function warnIfBacklogged() {
  if (!queueWarned && writer.queueDepth > QUEUE_WARN_DEPTH) {
    queueWarned = true;
    logLine(`Write queue backlog: ${writer.queueDepth} pending writes`, 'error');
  }
}

function updateCounters() {
  el.countRequests.textContent = String(totals.requests);
  el.countScreenshots.textContent = String(totals.screenshots);
  el.countBytes.textContent = formatBytes(writer ? writer.bytesWritten : 0);
}

const MAX_LOG_LINES = 500;

function logLine(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  if (cls) li.className = cls;
  el.log.appendChild(li);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstElementChild.remove();
  el.log.scrollTop = el.log.scrollHeight;
  // Persist to session.log while a session is active, for later analysis.
  if (writer && (state === 'recording' || state === 'starting' || state === 'paused')) {
    writer.appendLog(cls === 'error' ? 'error' : 'info', text);
  }
}

// Nothing may fail silently: uncaught panel errors go to the log (and disk).
window.addEventListener('error', (e) => {
  logLine(`Panel error: ${e.message} (${e.filename}:${e.lineno})`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  logLine(`Panel unhandled rejection: ${e.reason?.message || e.reason}`, 'error');
});

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.hidden = false;
}

function hideError() {
  el.errorBanner.hidden = true;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
