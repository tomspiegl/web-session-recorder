// Session viewer: opens a recorded session folder (File System Access API),
// renders the event timeline, previews request bodies and screenshots, and
// replays the session's screenshots in capture-time order.

const el = {
  openFolder: document.getElementById('open-folder'),
  sessionSelect: document.getElementById('session-select'),
  summary: document.getElementById('session-summary'),
  replayBar: document.getElementById('replay-bar'),
  replayPrev: document.getElementById('replay-prev'),
  replayPlay: document.getElementById('replay-play'),
  replayNext: document.getElementById('replay-next'),
  replaySpeed: document.getElementById('replay-speed'),
  replaySkipPauses: document.getElementById('replay-skip-pauses'),
  replayPos: document.getElementById('replay-pos'),
  replayUrl: document.getElementById('replay-url'),
  main: document.getElementById('main'),
  emptyHint: document.getElementById('empty-hint'),
  timeline: document.getElementById('timeline'),
  detail: document.getElementById('detail'),
  fRequests: document.getElementById('f-requests'),
  fNav: document.getElementById('f-nav'),
  fShots: document.getElementById('f-shots'),
  fClicks: document.getElementById('f-clicks'),
  fText: document.getElementById('f-text'),
};

const MAX_TEXT_PREVIEW = 500_000; // chars
const REPLAY_MAX_STEP_MS = 4000;
const REPLAY_MIN_STEP_MS = 300;

let sessionDir = null;
let events = [];
let screenshots = []; // subset of events with type === 'screenshot'
let pauseSeqs = []; // seq numbers of 'pause' marker events
let selectedSeq = null;
let playIndex = -1;
let playing = false;
let playTimer = null;
let objectUrls = [];

el.openFolder.addEventListener('click', openFolder);
el.sessionSelect.addEventListener('change', onSessionSelected);
for (const box of [el.fRequests, el.fNav, el.fShots, el.fClicks]) {
  box.addEventListener('change', renderTimeline);
}
el.fText.addEventListener('input', renderTimeline);
el.replayPrev.addEventListener('click', () => stepReplay(-1));
el.replayNext.addEventListener('click', () => stepReplay(1));
el.replayPlay.addEventListener('click', togglePlay);

let availableSessions = [];

async function openFolder() {
  let picked;
  try {
    picked = await window.showDirectoryPicker();
  } catch {
    return; // cancelled
  }
  availableSessions = await findSessions(picked);
  if (availableSessions.length === 0) {
    el.summary.textContent = 'No session found (missing events.jsonl) in the selected folder.';
    return;
  }
  // Newest first — session folder names sort chronologically.
  availableSessions.sort((a, b) => b.name.localeCompare(a.name));
  el.sessionSelect.innerHTML = '';
  for (const s of availableSessions) {
    const option = document.createElement('option');
    option.value = s.name;
    option.textContent = s.name;
    el.sessionSelect.appendChild(option);
  }
  el.sessionSelect.hidden = availableSessions.length < 2;
  await loadSession(availableSessions[0].handle);
}

async function onSessionSelected() {
  const found = availableSessions.find((s) => s.name === el.sessionSelect.value);
  if (found) await loadSession(found.handle);
}

/** A "session" is any directory containing events.jsonl — the picked folder itself or its children. */
async function findSessions(dir) {
  if (await hasFile(dir, 'events.jsonl')) return [{ name: dir.name, handle: dir }];
  const sessions = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory' && (await hasFile(entry, 'events.jsonl'))) {
      sessions.push({ name: entry.name, handle: entry });
    }
  }
  return sessions;
}

async function hasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function loadSession(dirHandle) {
  stopPlayback();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  sessionDir = dirHandle;
  selectedSeq = null;
  playIndex = -1;

  let info = null;
  try {
    info = JSON.parse(await (await readFile('session.json')).text());
  } catch {
    // Aborted or ancient session; timeline still works.
  }

  const jsonl = await (await readFile('events.jsonl')).text();
  events = jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq);
  screenshots = events.filter((e) => e.type === 'screenshot');
  pauseSeqs = events.filter((e) => e.type === 'pause').map((e) => e.seq);

  renderSummary(info);
  renderTimeline();
  el.main.hidden = false;
  el.emptyHint.hidden = true;
  el.replayBar.hidden = false;
  updateReplayControls();
  el.detail.innerHTML = '';
  if (info?.note) {
    const noteBox = document.createElement('p');
    noteBox.className = 'hint';
    noteBox.textContent = `📝 ${info.note}`;
    el.detail.appendChild(noteBox);
  }
  el.detail.appendChild(hint(
    screenshots.length
      ? `Loaded ${events.length} events, ${screenshots.length} screenshots. Press ▶ to replay.`
      : `Loaded ${events.length} events. No screenshots in this session — replay unavailable.`
  ));
}

function renderSummary(info) {
  if (!info) {
    el.summary.textContent = `${sessionDir.name} — no session.json (aborted session?)`;
    return;
  }
  const duration = info.endedAt
    ? `${Math.round((new Date(info.endedAt) - new Date(info.startedAt)) / 1000)}s`
    : 'aborted';
  const parts = [
    info.name || sessionDir.name,
    info.startUrl,
    duration,
    `${info.totals?.requests ?? '?'} requests`,
    `stop: ${info.stopReason ?? 'n/a'}`,
  ];
  if (info.resumedAt?.length) parts.push(`resumed ×${info.resumedAt.length}`);
  el.summary.textContent = parts.join(' · ');
  el.summary.title = info.note ? `${el.summary.textContent}\n\nNote: ${info.note}` : el.summary.textContent;
}

// ---------- timeline ----------

function renderTimeline() {
  const showRequests = el.fRequests.checked;
  const showNav = el.fNav.checked;
  const showShots = el.fShots.checked;
  const showClicks = el.fClicks.checked;
  const text = el.fText.value.trim().toLowerCase();

  el.timeline.innerHTML = '';
  for (const ev of events) {
    const isNav = ev.type === 'navigation' || ev.type === 'pageLoad';
    if (ev.type === 'request' && !showRequests) continue;
    if (isNav && !showNav) continue;
    if (ev.type === 'screenshot' && !showShots) continue;
    if (ev.type === 'interaction' && !showClicks) continue;
    const searchable = [ev.url, ev.pageUrl, ev.target?.text, ev.target?.selector, ev.target?.label]
      .filter(Boolean).join(' ').toLowerCase();
    if (text && !searchable.includes(text)) continue;

    const li = document.createElement('li');
    li.dataset.seq = String(ev.seq);
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = shortTime(ev.ts) + ' ';
    li.appendChild(time);

    let label;
    if (ev.type === 'request') {
      label = `${ev.failed ? '✗' : ev.status ?? '?'} ${ev.method} ${shortUrl(ev.url)}`;
      if (ev.failed) li.classList.add('failed');
    } else if (ev.type === 'screenshot') {
      label = `📷 screenshot (${ev.trigger ?? 'manual'})`;
      li.classList.add('shot');
    } else if (ev.type === 'interaction') {
      const what = ev.target?.text || ev.target?.label || ev.target?.selector || '';
      label = `● ${ev.kind}${ev.key ? ` ${ev.key}` : ''} ${what}`;
      li.classList.add('interaction');
    } else {
      label = ev.event === 'frameNavigated' || ev.event === 'navigatedWithinDocument'
        ? `⭢ ${shortUrl(ev.url)}${ev.isMainFrame === false ? ' (frame)' : ''}`
        : `· ${ev.event || ev.type}`;
      li.classList.add('nav');
    }
    li.appendChild(document.createTextNode(label));
    li.title = ev.url || ev.pageUrl || label;
    if (ev.seq === selectedSeq) li.classList.add('selected');
    li.addEventListener('click', () => selectEvent(ev));
    el.timeline.appendChild(li);
  }
}

function selectEvent(ev, { fromReplay = false } = {}) {
  if (!fromReplay) stopPlayback();
  selectedSeq = ev.seq;
  for (const li of el.timeline.children) {
    li.classList.toggle('selected', Number(li.dataset.seq) === ev.seq);
  }
  const selected = el.timeline.querySelector('.selected');
  selected?.scrollIntoView({ block: 'nearest' });
  showDetail(ev).catch((e) => {
    el.detail.innerHTML = '';
    el.detail.appendChild(hint(`Could not load event data: ${e.message}`));
  });
}

// ---------- detail pane ----------

async function showDetail(ev) {
  el.detail.innerHTML = '';
  if (ev.type === 'screenshot') return showScreenshotDetail(ev);
  if (ev.type === 'request') return showRequestDetail(ev);
  if (ev.type === 'interaction') return showInteractionDetail(ev);
  el.detail.appendChild(kvTable(Object.entries(ev)));
}

function showInteractionDetail(ev) {
  const t = ev.target || {};
  el.detail.appendChild(kvTable([
    ['time', ev.ts],
    ['kind', ev.kind + (ev.key ? ` (${ev.key})` : '')],
    ['element', [t.tag, t.role && `role=${t.role}`].filter(Boolean).join(' ')],
    ['selector', t.selector],
    ['text', t.text],
    ['label', t.label],
    ['href', t.href],
    ['value', ev.value],
    ['checked', ev.checked],
    ['form', ev.form ? `${ev.form.method?.toUpperCase() ?? ''} ${ev.form.action ?? ''}` : undefined],
    ['position', ev.x != null ? `${ev.x}, ${ev.y}` : undefined],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '')));
}

async function showScreenshotDetail(ev) {
  const img = document.createElement('img');
  img.className = 'shot';
  img.src = await fileUrl(ev.file);
  el.detail.appendChild(img);

  let meta = null;
  if (ev.metaFile) {
    try {
      meta = JSON.parse(await (await readFile(ev.metaFile)).text());
    } catch {
      // older session without sidecar
    }
  }
  const rows = [
    ['time', ev.ts],
    ['trigger', meta?.trigger ?? ev.trigger ?? 'manual'],
    ['page URL', meta?.pageUrl ?? ev.pageUrl ?? ''],
    ['page title', meta?.pageTitle ?? ''],
    ['file', ev.file],
  ];
  el.detail.appendChild(kvTable(rows));

  // Rendered DOM at capture time — for SPAs this is the framework-built
  // state, unlike the network-delivered HTML shell below.
  const domFile = meta?.domFile ?? ev.domFile;
  if (domFile) {
    const p = document.createElement('p');
    p.append('Rendered DOM at capture: ');
    p.appendChild(fileLink(domFile, () => showFilePreview(domFile)));
    el.detail.appendChild(p);
  }

  const docFile = meta?.document?.file ?? ev.documentFile;
  if (docFile) {
    const p = document.createElement('p');
    p.append('HTML document (as delivered): ');
    p.appendChild(
      fileLink(docFile, () => {
        const docEvent = events.find((e) => e.bodyFile === docFile);
        if (docEvent) {
          selectEvent(docEvent);
        } else {
          showFilePreview(docFile);
        }
      })
    );
    el.detail.appendChild(p);
  }
}

function fileLink(text, onClick) {
  const link = document.createElement('button');
  link.className = 'doc-link';
  link.textContent = text;
  link.addEventListener('click', onClick);
  return link;
}

async function showRequestDetail(ev) {
  const rows = [
    ['time', ev.ts],
    ['method', ev.method],
    ['status', ev.failed ? `FAILED: ${ev.failed}` : ev.status],
    ['URL', ev.url],
    ['MIME type', ev.mimeType ?? ''],
    ['body size', ev.size ? `${ev.size} bytes` : '(no body)'],
  ];
  el.detail.appendChild(kvTable(rows));

  let meta = null;
  if (ev.metaFile) {
    try {
      meta = JSON.parse(await (await readFile(ev.metaFile)).text());
    } catch (e) {
      el.detail.appendChild(hint(`Metadata unavailable: ${e.message}`));
    }
  }

  // Submitted data (form fields, JSON payloads) — shown prominently.
  if (meta?.request?.postData) {
    const h = document.createElement('h3');
    h.textContent = 'Request payload (submitted data)';
    el.detail.appendChild(h);
    const pre = document.createElement('pre');
    pre.textContent = prettyPayload(meta.request.postData);
    el.detail.appendChild(pre);
  }

  if (meta) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Full metadata (headers, timing, initiator…)';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(meta, null, 2);
    details.appendChild(pre);
    el.detail.appendChild(details);
  }

  if (ev.bodyFile) await appendBodyPreview(ev.bodyFile);
}

async function showFilePreview(relPath) {
  el.detail.innerHTML = '';
  el.detail.appendChild(kvTable([['file', relPath]]));
  await appendBodyPreview(relPath);
}

async function appendBodyPreview(relPath) {
  const ext = relPath.split('.').pop().toLowerCase();
  const h = document.createElement('h3');
  h.textContent = 'Body';
  el.detail.appendChild(h);

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = await fileUrl(relPath);
    el.detail.appendChild(img);
    return;
  }

  const textExts = ['json', 'html', 'css', 'js', 'xml', 'txt', 'md', 'csv'];
  if (textExts.includes(ext)) {
    const file = await readFile(relPath);
    let text = await file.text();
    let truncated = false;
    if (text.length > MAX_TEXT_PREVIEW) {
      text = text.slice(0, MAX_TEXT_PREVIEW);
      truncated = true;
    }
    if (ext === 'json') {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // show as-is (truncated or invalid JSON)
      }
    }
    const pre = document.createElement('pre');
    pre.textContent = text + (truncated ? '\n… (truncated preview)' : '');
    el.detail.appendChild(pre);
    return;
  }

  const file = await readFile(relPath);
  const a = document.createElement('a');
  a.href = await fileUrl(relPath);
  a.download = relPath.split('/').pop();
  a.textContent = `Download binary file (${file.size} bytes)`;
  el.detail.appendChild(a);
}

// ---------- replay ----------

function updateReplayControls() {
  const has = screenshots.length > 0;
  el.replayPrev.disabled = !has;
  el.replayPlay.disabled = !has;
  el.replayNext.disabled = !has;
  el.replayPos.textContent = has
    ? `${playIndex + 1 > 0 ? playIndex + 1 : '–'}/${screenshots.length}`
    : 'no screenshots';
  const current = screenshots[playIndex];
  el.replayUrl.textContent = current?.pageUrl ?? '';
}

function stepReplay(delta) {
  if (!screenshots.length) return;
  stopPlayback();
  playIndex = Math.min(screenshots.length - 1, Math.max(0, (playIndex < 0 ? 0 : playIndex + delta)));
  showReplayFrame();
}

function togglePlay() {
  if (playing) {
    stopPlayback();
    return;
  }
  if (!screenshots.length) return;
  playing = true;
  el.replayPlay.textContent = '⏸';
  if (playIndex < 0 || playIndex >= screenshots.length - 1) playIndex = 0;
  showReplayFrame();
  scheduleNextFrame();
}

function scheduleNextFrame() {
  if (!playing) return;
  if (playIndex >= screenshots.length - 1) {
    stopPlayback();
    return;
  }
  const current = screenshots[playIndex];
  const next = screenshots[playIndex + 1];
  let wait;
  if (el.replaySkipPauses.checked && hasPauseBetween(current.seq, next.seq)) {
    wait = REPLAY_MIN_STEP_MS; // jump over the paused period
  } else {
    const speed = Number(el.replaySpeed.value);
    const delta = new Date(next.ts) - new Date(current.ts);
    wait = Math.max(REPLAY_MIN_STEP_MS, Math.min(REPLAY_MAX_STEP_MS, delta / speed));
  }
  playTimer = setTimeout(() => {
    playIndex++;
    showReplayFrame();
    scheduleNextFrame();
  }, wait);
}

function hasPauseBetween(seqA, seqB) {
  return pauseSeqs.some((seq) => seq > seqA && seq < seqB);
}

function stopPlayback() {
  playing = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  el.replayPlay.textContent = '▶';
}

function showReplayFrame() {
  const ev = screenshots[playIndex];
  if (!ev) return;
  selectEvent(ev, { fromReplay: true });
  updateReplayControls();
}

// ---------- file helpers ----------

async function readFile(relPath) {
  const parts = relPath.split('/');
  let dir = sessionDir;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
  return fileHandle.getFile();
}

async function fileUrl(relPath) {
  const file = await readFile(relPath);
  const url = URL.createObjectURL(file);
  objectUrls.push(url);
  return url;
}

// ---------- small DOM helpers ----------

function kvTable(rows) {
  const table = document.createElement('table');
  table.className = 'kv';
  for (const [key, value] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = key;
    const td2 = document.createElement('td');
    td2.textContent = value == null ? '' : String(value);
    tr.append(td1, td2);
    table.appendChild(tr);
  }
  return table;
}

function prettyPayload(postData) {
  try {
    return JSON.stringify(JSON.parse(postData), null, 2);
  } catch {
    // Not JSON — decode form-urlencoded payloads into readable lines.
  }
  if (/^[^=\s&]+=[^&\s]*(&[^=\s&]+=[^&\s]*)*$/.test(postData)) {
    try {
      return [...new URLSearchParams(postData)]
        .map(([key, value]) => `${key} = ${value}`)
        .join('\n');
    } catch {
      // fall through to raw
    }
  }
  return postData;
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

function shortTime(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function shortUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return u.host + (path.length > 60 ? path.slice(0, 57) + '…' : path);
  } catch {
    return url.slice(0, 80);
  }
}
