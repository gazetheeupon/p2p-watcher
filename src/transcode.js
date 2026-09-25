import { extOf, needsTranscode } from './vfs.js';

let ffmpeg = null;
let loading = null;
let ffmpegChain = Promise.resolve();

function withFfmpeg(fn) {
  const run = ffmpegChain.then(fn, fn);
  ffmpegChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export const LARGE_REMUX_BYTES = 256 * 1024 * 1024;
export const SEGMENT_SECONDS = 2;

const FFMPEG_JS = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
const FFMPEG_WORKER = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';
const CORE_JS = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
const CORE_WASM = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';
// The published loader does `new Worker(unpkg/.../814.ffmpeg.js)`. A
// cross-origin-isolated page (required for the converter) refuses that
// worker. Same bytes, served as a blob from this page, are allowed.
const WORKER_CTOR = 'new Worker(new URL(e.p+e.u(814),e.b),{type:void 0})';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function loadFfmpegLibrary() {
  if (globalThis.FFmpegWASM) return;
  const [jsRes, workerRes] = await Promise.all([fetch(FFMPEG_JS), fetch(FFMPEG_WORKER)]);
  if (!jsRes.ok) throw new Error('failed to load ' + FFMPEG_JS);
  if (!workerRes.ok) throw new Error('failed to load ' + FFMPEG_WORKER);
  const js = await jsRes.text();
  if (!js.includes(WORKER_CTOR)) throw new Error('ffmpeg loader changed; cannot start it on this page');
  const workerUrl = URL.createObjectURL(new Blob([await workerRes.arrayBuffer()], { type: 'text/javascript' }));
  const patched = js.replace(WORKER_CTOR, `new Worker(${JSON.stringify(workerUrl)},{type:void 0})`);
  await loadScript(URL.createObjectURL(new Blob([patched], { type: 'text/javascript' })));
}

async function blobUrl(url, type) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('failed to load ' + url);
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

async function safeUnlink(ff, name) {
  try {
    await ff.FS('unlink', name);
  } catch {
    /* missing is fine */
  }
}

function copyOut(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return u8.slice();
}

export async function ensureFfmpeg(onProgress) {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    const coreURLP = blobUrl(CORE_JS, 'text/javascript');
    const wasmURLP = blobUrl(CORE_WASM, 'application/wasm');
    await loadFfmpegLibrary();
    const core = new globalThis.FFmpegWASM.FFmpeg();
    const recent = [];
    core.on('log', ({ message }) => {
      if (!message) return;
      recent.push(message);
      if (recent.length > 12) recent.shift();
    });
    if (onProgress) {
      core.on('progress', ({ progress }) => {
        if (progress >= 0 && progress <= 1) onProgress(progress);
      });
    }
    await core.load({ coreURL: await coreURLP, wasmURL: await wasmURLP });
    ffmpeg = {
      raw: core,
      held: null,
      async run(...args) {
        const code = await core.exec(args);
        if (code !== 0) {
          const tail = recent.slice(-4).join(' ').replace(/\s+/g, ' ').trim();
          throw new Error(tail || 'ffmpeg exited with code ' + code);
        }
      },
      FS(method, ...args) {
        if (method === 'readFile') return core.readFile(args[0]);
        if (method === 'unlink') return core.deleteFile(args[0]);
        if (method === 'writeFile') return core.writeFile(args[0], args[1]);
        if (method === 'mkdir') return core.createDir(args[0]);
        if (method === 'unmount') return core.unmount(args[0]);
        throw new Error('unsupported FS method ' + method);
      },
      setLogger(fn) {
        core.on('log', ({ message }) => fn({ message }));
      },
      async mountFile(file) {
        const ok = await core.mount('WORKERFS', { files: [file] }, '/in');
        if (!ok) throw new Error('Could not read this file from disk');
      },
      unmountIn() {
        return core.unmount('/in');
      },
    };
    return ffmpeg;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    ffmpeg = null;
    throw err;
  }
}

async function mountInput(ff, file) {
  const inName = 'in' + (extOf(file.name) ? '.' + extOf(file.name) : '.mkv');
  // A dropped movie stays on disk. The converter reads the slices it needs
  // (a couple of seconds at a time) instead of copying the whole file in.
  if (typeof Blob !== 'undefined' && file instanceof Blob && file.name) {
    const inputPath = '/in/' + file.name;
    if (ff.held === file) return { inputPath, inName, held: true };
    if (ff.held) {
      try {
        await ff.unmountIn();
      } catch {
        /* already gone */
      }
      ff.held = null;
    }
    try {
      await ff.FS('mkdir', '/in');
    } catch {
      /* exists */
    }
    await ff.mountFile(file);
    ff.held = file;
    return { inputPath, inName, held: true };
  }
  if (file.size > 64 * 1024 * 1024) {
    throw new Error('This file is too large to copy into memory');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  await ff.FS('writeFile', inName, buf);
  return { inputPath: inName, inName, held: false };
}

function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function probeMediaDuration(file) {
  return withFfmpeg(async () => {
    const ff = await ensureFfmpeg();
    const mount = await mountInput(ff, file);
    const lines = [];
    ff.setLogger(({ message }) => lines.push(message));
    try {
      await ff.run('-i', mount.inputPath);
    } catch {
      /* ffmpeg exits non-zero when it is only asked to identify the file */
    } finally {
      await unmountInput(ff, mount);
    }
    const duration = parseDuration(lines.join('\n'));
    if (!duration) throw new Error('Could not read how long this file is');
    return duration;
  });
}

export async function remuxSegment(file, start, dur = SEGMENT_SECONDS) {
  return withFfmpeg(async () => {
    const ff = await ensureFfmpeg();
    const mount = await mountInput(ff, file);
    const out = 'seg.mp4';
    await safeUnlink(ff, out);
    try {
      await ff.run(
        '-ss',
        String(Math.max(0, start)),
        '-i',
        mount.inputPath,
        '-t',
        String(dur),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-avoid_negative_ts',
        'make_zero',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        out,
      );
      const data = copyOut(await ff.FS('readFile', out));
      await safeUnlink(ff, out);
      return data;
    } finally {
      await unmountInput(ff, mount);
    }
  });
}

async function unmountInput(ff, mount) {
  // Keep a disk mount in place. The next few seconds of the same movie
  // reuse it; a different file replaces it in mountInput.
  if (mount.held) return;
  await safeUnlink(ff, mount.inName);
}

export async function remuxToFragmentedMp4(file, onProgress) {
  return withFfmpeg(() => remuxWholeFile(file, onProgress));
}

async function remuxWholeFile(file, onProgress) {
  const ff = await ensureFfmpeg(onProgress);
  const mount = await mountInput(ff, file);
  const outMp4 = 'out.mp4';
  const outWebm = 'out.webm';
  const outVtt = 'subs.vtt';
  let blob;
  let mime = 'video/mp4';
  let outName = outMp4;
  try {
    // Three tiers, cheapest/fastest first. A real "ripped" .mkv very often
    // carries a browser-playable video codec (H.264/HEVC) alongside an
    // audio codec no browser decodes (AC-3, DTS, TrueHD) — that combination
    // used to go straight to the full re-encode fallback below (slow: a
    // real movie can take many minutes of single-threaded wasm CPU time),
    // even though only the audio track actually needed re-encoding.
    try {
      // Tier 1: copy both streams — fast (seconds), works when the source
      // is already H.264/HEVC + AAC/MP3. +faststart puts the index at the
      // front so the viewer can play and seek with ordinary range requests.
      // A fragmented MP4 (empty moov) cannot.
      await ff.run(
        '-i',
        mount.inputPath,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outMp4,
      );
    } catch {
      try {
        // Tier 2: keep the (usually browser-playable) video stream as-is,
        // re-encode only the audio to AAC. Still fast — audio re-encode is
        // cheap compared to video — and fixes the single most common real
        // failure (AC-3/DTS/TrueHD audio in an otherwise-fine H.264 file).
        await safeUnlink(ff, outMp4);
        await ff.run(
          '-i',
          mount.inputPath,
          '-map',
          '0:v:0?',
          '-map',
          '0:a:0?',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '160k',
          '-movflags',
          '+faststart',
          outMp4,
        );
      } catch {
        // Tier 3: last resort, full re-encode. This is the slow path (can
        // legitimately take minutes for a real file) — it only runs when
        // the video stream itself can't be carried into MP4 as-is.
        await safeUnlink(ff, outMp4);
        await ff.run('-i', mount.inputPath, '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis', outWebm);
        outName = outWebm;
        mime = 'video/webm';
      }
    }
    const data = await ff.FS('readFile', outName);
    blob = new Blob([copyOut(data)], { type: mime });
    await safeUnlink(ff, outName);

    let vtt = null;
    try {
      await ff.run('-i', mount.inputPath, '-map', '0:s:0', '-c:s', 'webvtt', outVtt);
      const sub = await ff.FS('readFile', outVtt);
      vtt = new TextDecoder().decode(copyOut(sub));
      await safeUnlink(ff, outVtt);
    } catch {
      vtt = null;
    }
    return { blob, vtt };
  } finally {
    await unmountInput(ff, mount);
  }
}

export async function extractEmbeddedVtt(file) {
  const { vtt } = await remuxToFragmentedMp4(file);
  return vtt;
}

export { needsTranscode };
