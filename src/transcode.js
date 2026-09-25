import { extOf, needsTranscode } from './vfs.js';

let ffmpeg = null;
let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

function safeUnlink(ff, name) {
  try {
    ff.FS('unlink', name);
  } catch {
    /* missing is fine */
  }
}

function copyOut(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return u8.slice();
}

export async function ensureFfmpeg(onProgress) {
  if (ffmpeg?.isLoaded?.()) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    if (!globalThis.FFmpeg) {
      await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
    }
    const { createFFmpeg } = globalThis.FFmpeg;
    ffmpeg = createFFmpeg({
      log: false,
      corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    });
    if (onProgress) {
      ffmpeg.setProgress(({ ratio }) => {
        if (ratio >= 0 && ratio <= 1) onProgress(ratio);
      });
    }
    await ffmpeg.load();
    return ffmpeg;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

async function mountInput(ff, file) {
  const inName = 'in' + (extOf(file.name) ? '.' + extOf(file.name) : '.mkv');
  try {
    try {
      ff.FS('mkdir', '/in');
    } catch {
      /* exists */
    }
    const emfs = ff.ffmpeg?.FS;
    const workerfs = emfs?.filesystems?.WORKERFS;
    if (workerfs && typeof File !== 'undefined' && file instanceof File) {
      try {
        emfs.unmount('/in');
      } catch {
        /* not mounted */
      }
      const named = new File([file], inName, { type: file.type });
      emfs.mount(workerfs, { files: [named] }, '/in');
      return { inputPath: '/in/' + inName, mounted: true, inName };
    }
  } catch {
    /* fall through to writeFile */
  }
  const { fetchFile } = globalThis.FFmpeg;
  ff.FS('writeFile', inName, await fetchFile(file));
  return { inputPath: inName, mounted: false, inName };
}

function unmountInput(ff, mount) {
  if (mount.mounted) {
    try {
      ff.ffmpeg.FS.unmount('/in');
    } catch {
      try {
        ff.FS('unmount', '/in');
      } catch {
        /* ignore */
      }
    }
  } else {
    safeUnlink(ff, mount.inName);
  }
}

export async function remuxToFragmentedMp4(file, onProgress) {
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
        safeUnlink(ff, outMp4);
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
        safeUnlink(ff, outMp4);
        await ff.run('-i', mount.inputPath, '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis', outWebm);
        outName = outWebm;
        mime = 'video/webm';
      }
    }
    const data = ff.FS('readFile', outName);
    blob = new Blob([copyOut(data)], { type: mime });
    safeUnlink(ff, outName);

    let vtt = null;
    try {
      await ff.run('-i', mount.inputPath, '-map', '0:s:0', '-c:s', 'webvtt', outVtt);
      const sub = ff.FS('readFile', outVtt);
      vtt = new TextDecoder().decode(copyOut(sub));
      safeUnlink(ff, outVtt);
    } catch {
      vtt = null;
    }
    return { blob, vtt };
  } finally {
    unmountInput(ff, mount);
  }
}

export async function extractEmbeddedVtt(file) {
  const { vtt } = await remuxToFragmentedMp4(file);
  return vtt;
}

export { needsTranscode };
