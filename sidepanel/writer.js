// SessionWriter: owns the user-picked FileSystemDirectoryHandle and performs
// all disk writes through a serialized queue, so on-disk order matches the
// sequence numbers assigned by the service worker.

import {
  extensionForMime,
  sanitizeSegment,
  stripExtension,
  filenameTimestamp,
  padSeq,
  base64ToBytes,
} from '../shared/mime.js';

const JSONL_FLUSH_MS = 500;
const JSONL_FLUSH_LINES = 25;
export const QUEUE_WARN_DEPTH = 200;

export class SessionWriter {
  /**
   * @param {FileSystemDirectoryHandle} rootHandle user-picked root folder
   * @param {(err: Error) => void} onError called when any queued write fails
   */
  constructor(rootHandle, onError) {
    this.rootHandle = rootHandle;
    this.onError = onError;
    this.queueDepth = 0;
    this.bytesWritten = 0;
    this._chain = Promise.resolve();
    this._pendingLines = [];
    this._flushTimer = null;
    this._eventsOffset = 0;
  }

  /** Create (or open) a session folder by name under the root handle. */
  async init(folderName) {
    this.folderName = folderName;
    this.sessionDir = await this.rootHandle.getDirectoryHandle(folderName, { create: true });
    await this._initFiles();
  }

  /** Open an existing session folder directly (Resume existing). */
  async initFromHandle(sessionDirHandle) {
    this.folderName = sessionDirHandle.name;
    this.sessionDir = sessionDirHandle;
    await this._initFiles();
  }

  async _initFiles() {
    this.requestsDir = await this.sessionDir.getDirectoryHandle('requests', { create: true });
    this.screenshotsDir = await this.sessionDir.getDirectoryHandle('screenshots', { create: true });
    this._eventsHandle = await this.sessionDir.getFileHandle('events.jsonl', { create: true });
    this._logHandle = await this.sessionDir.getFileHandle('session.log', { create: true });
    // Append after any existing content — a resumed session reuses its
    // folder, so events.jsonl and session.log must not be overwritten.
    this._eventsOffset = (await this._eventsHandle.getFile()).size;
    this._logOffset = (await this._logHandle.getFile()).size;
    this._pendingLog = [];
    this._logTimer = null;
  }

  _enqueue(taskFn) {
    this.queueDepth++;
    this._chain = this._chain
      .then(taskFn)
      .catch((e) => this.onError?.(e))
      .finally(() => {
        this.queueDepth--;
      });
    return this._chain;
  }

  async _writeFile(dirHandle, name, data) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    this.bytesWritten +=
      typeof data === 'string' ? data.length : data.byteLength ?? data.size ?? 0;
  }

  /**
   * Write body + sidecar .meta.json for one completed request.
   * Returns the relative file names used (for events.jsonl), synchronously.
   */
  writeRequestRecord(msg) {
    const { seq, ts, request, response, body } = msg;
    const base = buildRequestBase(seq, ts, request.method, request.url);

    let bodyFile = null;
    let bodySize = 0;
    if (body) {
      const ext = extensionForMime(response?.mimeType);
      bodyFile = `${base}.${ext}`;
      const data = body.base64Encoded ? base64ToBytes(body.data) : body.data;
      bodySize = typeof data === 'string' ? data.length : data.byteLength;
      this._enqueue(() => this._writeFile(this.requestsDir, bodyFile, data));
    }

    const metaFile = `${base}.meta.json`;
    const meta = {
      seq,
      ts,
      request,
      response,
      failed: msg.failed,
      timing: msg.timing,
      body: body
        ? { bodyFile: `requests/${bodyFile}`, bodySize, base64Encoded: body.base64Encoded }
        : { bodySkipped: msg.bodySkipped, bodyError: msg.bodyError },
    };
    this._enqueue(() =>
      this._writeFile(this.requestsDir, metaFile, JSON.stringify(meta, null, 2))
    );

    return {
      bodyFile: bodyFile ? `requests/${bodyFile}` : null,
      metaFile: `requests/${metaFile}`,
      bodySize,
    };
  }

  /**
   * Write one screenshot plus its .meta.json sidecar linking it to the page
   * and the captured main-frame HTML document. Returns relative file names.
   * @param {object} msg SCREENSHOT_DATA message { seq, ts, base64, trigger, pageUrl, pageTitle }
   * @param {{url, file, seq}|null} document last captured main-frame HTML document
   */
  writeScreenshot(msg, document) {
    const kind = msg.trigger === 'manual' ? 'manual' : 'auto';
    const base = `${padSeq(msg.seq)}_${filenameTimestamp(msg.ts)}_screenshot-${kind}`;
    const file = `${base}.png`;
    const metaFile = `${base}.meta.json`;

    this._enqueue(() => this._writeFile(this.screenshotsDir, file, base64ToBytes(msg.base64)));

    // Rendered DOM at capture time (what React/Angular actually built),
    // as opposed to the network-delivered HTML shell linked via `document`.
    let domFile = null;
    if (msg.dom) {
      domFile = `${base}.dom.html`;
      const dom = msg.dom;
      this._enqueue(() => this._writeFile(this.screenshotsDir, domFile, dom));
    }

    const meta = {
      seq: msg.seq,
      ts: msg.ts,
      trigger: msg.trigger,
      pageUrl: msg.pageUrl,
      pageTitle: msg.pageTitle,
      screenshotFile: `screenshots/${file}`,
      domFile: domFile ? `screenshots/${domFile}` : null,
      document: document
        ? { url: document.url, file: document.file, seq: document.seq }
        : null,
    };
    this._enqueue(() =>
      this._writeFile(this.screenshotsDir, metaFile, JSON.stringify(meta, null, 2))
    );

    return {
      file: `screenshots/${file}`,
      metaFile: `screenshots/${metaFile}`,
      domFile: domFile ? `screenshots/${domFile}` : null,
    };
  }

  /** Append one event line to events.jsonl (buffered). */
  appendEvent(obj) {
    this._pendingLines.push(JSON.stringify(obj) + '\n');
    if (this._pendingLines.length >= JSONL_FLUSH_LINES) {
      this.flushEvents();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flushEvents(), JSONL_FLUSH_MS);
    }
  }

  flushEvents() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pendingLines.length === 0) return;
    const bytes = new TextEncoder().encode(this._pendingLines.join(''));
    this._pendingLines = [];
    const position = this._eventsOffset;
    this._eventsOffset += bytes.byteLength;
    this._enqueue(async () => {
      const writable = await this._eventsHandle.createWritable({ keepExistingData: true });
      await writable.write({ type: 'write', position, data: bytes });
      await writable.close();
      this.bytesWritten += bytes.byteLength;
    });
  }

  /**
   * Append a line to session.log (persistent diagnostics for later analysis).
   * Error lines flush immediately so they survive a crash right after.
   */
  appendLog(level, message) {
    this._pendingLog.push(`${new Date().toISOString()} [${level || 'info'}] ${message}\n`);
    if (level === 'error' || this._pendingLog.length >= 25) {
      this.flushLog();
    } else if (!this._logTimer) {
      this._logTimer = setTimeout(() => this.flushLog(), 500);
    }
  }

  flushLog() {
    if (this._logTimer) {
      clearTimeout(this._logTimer);
      this._logTimer = null;
    }
    if (!this._pendingLog.length) return;
    const bytes = new TextEncoder().encode(this._pendingLog.join(''));
    this._pendingLog = [];
    const position = this._logOffset;
    this._logOffset += bytes.byteLength;
    // Deliberately NOT routed through onError: a failing log write must never
    // trigger error handling that logs again (infinite loop).
    this._chain = this._chain
      .then(async () => {
        const writable = await this._logHandle.createWritable({ keepExistingData: true });
        await writable.write({ type: 'write', position, data: bytes });
        await writable.close();
      })
      .catch(() => {});
  }

  /** Write an arbitrary extra file into the session folder root. */
  writeExtra(name, data) {
    this._enqueue(() => this._writeFile(this.sessionDir, name, data));
  }

  /** Write (or rewrite) session.json. */
  writeSessionJson(obj) {
    this._enqueue(() =>
      this._writeFile(this.sessionDir, 'session.json', JSON.stringify(obj, null, 2))
    );
  }

  /** Flush buffers and wait for every queued write to land on disk. */
  async finalize() {
    this.flushEvents();
    this.flushLog();
    await this._chain;
  }
}

function buildRequestBase(seq, ts, method, urlString) {
  let host = 'unknown-host';
  let segment = 'index';
  try {
    const u = new URL(urlString);
    host = u.host || u.protocol.replace(':', '');
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) segment = stripExtension(last) || 'index';
  } catch {
    // Keep defaults for unparseable URLs (e.g. about:blank).
  }
  return [
    padSeq(seq),
    filenameTimestamp(ts),
    sanitizeSegment(method || 'GET', 10),
    sanitizeSegment(host),
    sanitizeSegment(segment),
  ].join('_');
}
