// How long a fragmented MP4 runs, in seconds, measured from timestamp 0.
// empty_moov leaves mvhd duration at 0, so this walks the fragment samples.
// Returns 0 when the boxes are not a segment we understand.

const VIDEO = new Set(['vide']);
const AUDIO = new Set(['soun']);

function readType(bytes, o) {
  return String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
}

function boxSize(view, o, end) {
  const size = view.getUint32(o);
  if (size === 1 && o + 16 <= end) return Number(view.getBigUint64(o + 8));
  if (size === 0) return end - o;
  return size;
}

export function segmentSpan(bytes) {
  if (!bytes || bytes.byteLength < 16) return 0;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tracks = [];
  const trackEnd = [];

  const walk = (start, end, on) => {
    let o = start;
    while (o + 8 <= end) {
      const size = boxSize(view, o, end);
      if (size < 8 || o + size > end) break;
      const type = readType(u8, o);
      const hdr = view.getUint32(o) === 1 ? 16 : 8;
      on(type, o + hdr, o + size);
      o += size;
    }
  };

  walk(0, u8.byteLength, (type, body, boxEnd) => {
    if (type !== 'moov') return;
    walk(body, boxEnd, (t, b, e) => {
      if (t !== 'trak') return;
      let timescale = 0;
      let handler = '';
      walk(b, e, (tt, bb, ee) => {
        if (tt !== 'mdia') return;
        walk(bb, ee, (mt, mb) => {
          if (mt === 'mdhd') {
            const v = u8[mb];
            timescale = v === 1 ? view.getUint32(mb + 20) : view.getUint32(mb + 12);
          } else if (mt === 'hdlr' && mb + 12 <= ee) {
            handler = String.fromCharCode(u8[mb + 8], u8[mb + 9], u8[mb + 10], u8[mb + 11]);
          }
        });
      });
      tracks.push({ timescale, handler });
    });
  });

  walk(0, u8.byteLength, (type, body, boxEnd) => {
    if (type !== 'moof') return;
    let index = 0;
    walk(body, boxEnd, (t, b, e) => {
      if (t !== 'traf') return;
      const track = tracks[index++] || {};
      if (!VIDEO.has(track.handler) && !AUDIO.has(track.handler)) return;
      const scale = track.timescale || 0;
      if (!scale) return;
      let base = 0;
      let defaultDur = 0;
      let endTicks = 0;
      walk(b, e, (ft, fb, fe) => {
        if (ft === 'tfhd') {
          const flags = view.getUint32(fb) & 0xffffff;
          let p = fb + 8;
          if (flags & 0x000001) p += 8;
          if (flags & 0x000002) p += 4;
          if (flags & 0x000008 && p + 4 <= fe) defaultDur = view.getUint32(p);
        } else if (ft === 'tfdt') {
          const v = u8[fb];
          base = v === 1 ? Number(view.getBigUint64(fb + 4)) : view.getUint32(fb + 4);
        } else if (ft === 'trun') {
          const flags = view.getUint32(fb) & 0xffffff;
          const version = u8[fb];
          const count = view.getUint32(fb + 4);
          let p = fb + 8;
          if (flags & 0x000001) p += 4;
          if (flags & 0x000004) p += 4;
          let dts = base;
          for (let i = 0; i < count && p + 4 <= fe; i++) {
            let dur = defaultDur;
            let cts = 0;
            if (flags & 0x000100) {
              dur = view.getUint32(p);
              p += 4;
            }
            if (flags & 0x000200) p += 4;
            if (flags & 0x000400) p += 4;
            if (flags & 0x000800) {
              cts = version === 1 ? view.getInt32(p) : view.getUint32(p);
              p += 4;
            }
            const ptsEnd = dts + cts + dur;
            if (ptsEnd > endTicks) endTicks = ptsEnd;
            dts += dur;
          }
        }
      });
      const sec = endTicks / scale;
      if (sec > (trackEnd[index - 1] || 0)) trackEnd[index - 1] = sec;
    });
  });

  for (let i = 0; i < tracks.length; i++) {
    if (VIDEO.has(tracks[i].handler) && trackEnd[i] > 0) return trackEnd[i];
  }
  for (let i = 0; i < tracks.length; i++) {
    if (AUDIO.has(tracks[i].handler) && trackEnd[i] > 0) return trackEnd[i];
  }
  return 0;
}
