// Helpers for filenames, MIME-type mapping, timestamps and base64.

const MIME_EXT = {
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/manifest+json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/xhtml+xml': 'html',
  'text/html': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'text/javascript': 'js',
  'application/wasm': 'wasm',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-www-form-urlencoded': 'txt',
  'application/octet-stream': 'bin',
};

/** Derive a file extension (without dot) from a Content-Type / mimeType value. */
export function extensionForMime(mime) {
  if (!mime) return 'bin';
  const normalized = String(mime).split(';')[0].trim().toLowerCase();
  if (MIME_EXT[normalized]) return MIME_EXT[normalized];
  const [type, subtype] = normalized.split('/');
  if (['image', 'font', 'audio', 'video'].includes(type) && subtype) {
    return subtype.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  }
  return 'bin';
}

/** Make a string safe for use as a filename segment. Keeps letters, digits, dot, dash, underscore. */
export function sanitizeSegment(s, maxLen = 60) {
  const cleaned = String(s)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (cleaned || 'unnamed').slice(0, maxLen);
}

/** Strip a short trailing extension (e.g. ".html", ".js") from a path segment. */
export function stripExtension(segment) {
  return segment.replace(/\.[a-zA-Z0-9]{1,6}$/, '');
}

/** UTC ISO-8601 timestamp made filename-safe (colons -> dashes). */
export function filenameTimestamp(isoString) {
  return isoString.replace(/:/g, '-');
}

/** Local wall-clock session folder name: YYYY-MM-DDTHH-mm-ss_<name|session> */
export function sessionFolderName(name = null, date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const suffix = name ? sanitizeSegment(name, 40) : 'session';
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}_${suffix}`
  );
}

/** Zero-padded global sequence number for filenames. */
export function padSeq(seq) {
  return String(seq).padStart(6, '0');
}

/** Decode a base64 string into a Uint8Array. */
export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
