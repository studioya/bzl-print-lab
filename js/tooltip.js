// One tooltip for the whole page, so every tooltip looks and behaves the same:
// dark box, bold title, description, Hebrew line; shown after a short hover
// delay (immediately on keyboard focus); placed above the element, or below
// when there's no room, and kept inside the window (panels that clip their
// content can't cut it off).
//
// Content comes from either
//   data-tip="Title" [data-tip-desc="…"] [data-tip-he="…"]   on the element, or
//   a hidden <span class="p-tip"> inside it (rich HTML: .p-spec, .p-desc, .he).

const DELAY = 550;
const SOURCE = '[data-tip], .has-tip, .profile';

let box, arrow, timer = 0, current = null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function contentOf(el) {
  if (el.dataset.tip) {
    const { tip, tipDesc, tipHe } = el.dataset;
    return `<span class="p-spec">${esc(tip)}</span>${tipDesc || tipHe ? `<span class="p-desc">${esc(tipDesc || '')}${tipHe
      ? `<span class="he" lang="he" dir="rtl">${esc(tipHe)}</span>` : ''}</span>` : ''}`;
  }
  return el.querySelector('.p-tip')?.innerHTML || '';
}

function show(el) {
  const html = contentOf(el);
  if (!html) return;
  current = el;
  box.innerHTML = html;
  box.appendChild(arrow);
  box.classList.add('on');
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const m = 8, gap = 8, vw = document.documentElement.clientWidth;
  const above = r.top - b.height - gap >= m;
  const top = above ? r.top - b.height - gap : r.bottom + gap;
  const cx = r.left + Math.min(r.width / 2, 40); // near the element's start, like a pointer
  const left = Math.min(Math.max(m, cx - 24), vw - b.width - m);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.classList.toggle('below', !above);
  arrow.style.left = `${Math.min(Math.max(10, cx - left - 6), b.width - 22)}px`;
}

export function hideTooltip() {
  clearTimeout(timer);
  current = null;
  box?.classList.remove('on');
}

export function initTooltips() {
  box = document.createElement('div');
  box.className = 'tooltip';
  box.setAttribute('role', 'tooltip');
  arrow = document.createElement('span');
  arrow.className = 'tooltip-arrow';
  document.body.appendChild(box);

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.(SOURCE);
    if (el === current) return;
    hideTooltip();
    if (el) { current = el; timer = setTimeout(() => current === el && show(el), DELAY); }
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.(SOURCE);
    if (el && el === current && !el.contains(e.relatedTarget)) hideTooltip();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.(SOURCE);
    if (el && e.target.matches(':focus-visible')) { hideTooltip(); show(el); }
  });
  document.addEventListener('focusout', hideTooltip);
  document.addEventListener('pointerdown', hideTooltip);
  // Touch screens have no hover: a tap shows the tooltip until the next tap.
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest?.(SOURCE);
    if (el) show(el);
  });
  window.addEventListener('scroll', hideTooltip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });
}
