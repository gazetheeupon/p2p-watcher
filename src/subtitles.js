export function stripExt(p) {
  return String(p).replace(/\.[a-z0-9]+$/i, '');
}

export function subtitleLang(name, videoBase) {
  const n = String(name).replace(/\.(srt|vtt)$/i, '');
  const prefix = videoBase + '.';
  const leaf = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
  const baseLeaf = videoBase.includes('/') ? videoBase.slice(videoBase.lastIndexOf('/') + 1) : videoBase;
  const leafPrefix = baseLeaf + '.';
  if (leaf.startsWith(leafPrefix)) {
    const tag = leaf.slice(leafPrefix.length);
    if (/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(tag)) return tag.toLowerCase();
  }
  if (n.startsWith(prefix)) {
    const tag = n.slice(prefix.length);
    if (/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(tag)) return tag.toLowerCase();
  }
  return 'und';
}

export function subtitleLabel(name, videoBase) {
  const lang = subtitleLang(name, videoBase);
  if (lang === 'und') return 'Subtitles';
  return lang;
}

export function pairSubtitles(entries) {
  const subs = entries.filter((e) => e.kind === 'subtitle');
  const others = entries.filter((e) => e.kind !== 'subtitle');
  return others.map((e) => {
    if (e.kind !== 'video' && e.kind !== 'audio') return { ...e, subtitles: [] };
    const base = stripExt(e.path);
    const nameBase = stripExt(e.name);
    const matched = subs
      .filter((s) => {
        const sp = stripExt(s.path);
        const sn = stripExt(s.name);
        return sp === base || sp.startsWith(base + '.') || sn === nameBase || sn.startsWith(nameBase + '.');
      })
      .map((s) => ({
        path: s.path,
        label: subtitleLabel(s.name, nameBase),
        lang: subtitleLang(s.name, nameBase),
      }));
    return { ...e, subtitles: matched };
  });
}

export const EMBEDDED_SUFFIX = '.embedded.vtt';

export function embeddedSubPath(videoPath) {
  return String(videoPath) + EMBEDDED_SUFFIX;
}

export function vttHasCues(vtt) {
  return typeof vtt === 'string' && /-->/.test(vtt);
}

export function attachEmbeddedSubtitle(fileEntry, vtt) {
  if (!fileEntry || !vttHasCues(vtt)) return null;
  const path = embeddedSubPath(fileEntry.path);
  const rec = { path, label: 'Embedded', lang: 'und', embedded: true };
  const subs = fileEntry.subtitles || [];
  if (subs.some((s) => s.embedded || s.path === path)) return path;
  fileEntry.subtitles = [...subs, rec];
  return path;
}

export function srtToVtt(srt) {
  const body = String(srt).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!body) return 'WEBVTT\n\n';
  if (/^WEBVTT/i.test(body)) return body.endsWith('\n') ? body : body + '\n';
  const blocks = body.split(/\n\n+/);
  const mapped = blocks
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.length);
      if (!lines.length) return '';
      let i = 0;
      if (/^\d+$/.test(lines[0].trim())) i = 1;
      if (!lines[i]) return '';
      const timing = lines[i].replace(/,/g, '.');
      const text = lines.slice(i + 1).join('\n');
      return `${timing}\n${text}`;
    })
    .filter(Boolean);
  return 'WEBVTT\n\n' + mapped.join('\n\n') + '\n';
}
