import { pairSubtitles } from './subtitles.js';

const EXT_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export const TRANSCODE_EXT = new Set(['mkv', 'avi']);

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

export function mimeOf(fileOrName, type = '') {
  if (fileOrName && typeof fileOrName === 'object') {
    if (fileOrName.type) return fileOrName.type;
    return mimeOf(fileOrName.name || fileOrName.path || '', '');
  }
  const ext = extOf(fileOrName);
  return type || EXT_MIME[ext] || 'application/octet-stream';
}

export function kindOf(path, mime) {
  const ext = extOf(path);
  if (ext === 'srt' || ext === 'vtt' || mime === 'text/vtt' || mime === 'application/x-subrip') return 'subtitle';
  if (mime.startsWith('video/') || ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg'].includes(ext)) return 'audio';
  return 'other';
}

export function needsTranscode(path, mime) {
  const ext = extOf(path);
  return TRANSCODE_EXT.has(ext) || mime === 'video/x-matroska' || mime === 'video/x-msvideo';
}

export function streamMime(path, mime) {
  return needsTranscode(path, mime) ? 'video/mp4' : mime;
}

export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

export function guessFolderName(files) {
  if (!files.length) return 'Library';
  const first = normalizePath(files[0].path);
  const parts = first.split('/');
  if (parts.length > 1) return parts[0];
  return 'Library';
}

export function buildMap({ sourceId, name, files }) {
  const entries = files.map(({ path, file }) => {
    const p = normalizePath(path);
    const mime = mimeOf({ name: p, type: file?.type });
    return {
      path: p,
      name: p.split('/').pop(),
      size: file?.size ?? 0,
      mime,
      kind: kindOf(p, mime),
      transcode: needsTranscode(p, mime),
    };
  });
  const media = pairSubtitles(entries);
  return {
    sourceId,
    name: name || guessFolderName(files),
    createdAt: new Date().toISOString(),
    files: media,
  };
}

export function filesFromFileList(list) {
  return [...list].map((f) => ({
    path: normalizePath(f.webkitRelativePath || f.name),
    file: f,
  }));
}

export async function filesFromDataTransfer(dt) {
  const items = [...(dt.items || [])];
  const walked = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) walked.push(walkEntry(entry, ''));
  }
  const nested = (await Promise.all(walked)).flat();
  if (nested.length) return nested;
  return [...(dt.files || [])].map((f) => ({ path: f.name, file: f }));
}

async function walkEntry(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ path: prefix + file.name, file }];
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readAllEntries(reader);
    const nested = await Promise.all(entries.map((e) => walkEntry(e, prefix + entry.name + '/')));
    return nested.flat();
  }
  return [];
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const tick = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        tick();
      }, reject);
    };
    tick();
  });
}

export function toFileMap(files) {
  const map = new Map();
  for (const { path, file } of files) map.set(normalizePath(path), file);
  return map;
}

export async function filesFromDirectoryHandle(handle, prefix = '') {
  const out = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file' && typeof entry.getFile === 'function') {
      const file = await entry.getFile();
      out.push({ path: normalizePath(prefix + name), file });
    } else if (entry.kind === 'directory' && typeof entry.entries === 'function') {
      out.push(...(await filesFromDirectoryHandle(entry, prefix + name + '/')));
    }
  }
  return out;
}
