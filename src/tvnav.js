export function isShown(el) {
  if (!el || el.disabled) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function visibleNavItems(root = document) {
  return [...root.querySelectorAll('[data-nav]')].filter(isShown);
}

export function nearestNav(current, items, key) {
  if (!current || !items.length) return null;
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let aligned = false;
    if (key === 'ArrowRight') aligned = dx > 4 && Math.abs(dx) >= Math.abs(dy) * 0.25;
    else if (key === 'ArrowLeft') aligned = dx < -4 && Math.abs(dx) >= Math.abs(dy) * 0.25;
    else if (key === 'ArrowDown') aligned = dy > 4 && Math.abs(dy) >= Math.abs(dx) * 0.25;
    else if (key === 'ArrowUp') aligned = dy < -4 && Math.abs(dy) >= Math.abs(dx) * 0.25;
    if (!aligned) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestScore) {
      best = el;
      bestScore = dist;
    }
  }
  return best;
}

export function bindSpatialNav(getRoot = () => document) {
  if (document._p2pSpatialNav) return;
  document._p2pSpatialNav = true;
  document.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    if (e.target && e.target.matches('video, input, textarea')) return;
    const root = getRoot() || document;
    const items = visibleNavItems(root);
    if (!items.length) return;
    const active = items.includes(document.activeElement) ? document.activeElement : null;
    if (!active) {
      items[0].focus();
      e.preventDefault();
      return;
    }
    const next = nearestNav(active, items, e.key);
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
}

export function bindGlobalEsc(handler) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') handler(e);
  });
}
