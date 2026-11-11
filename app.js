// How it works:
// - All text is stored as "runs": pieces of text sharing one style
//   ({ t, font, size, color, bold, italic, align }). `align` belongs to whole lines.
// - Runs are grouped into "sections". A new section starts only where the user clicks
//   "+ Add page". Pages are not stored: sections are re-split into pages after every change,
//   so text flows forward when a page fills up and back when it shrinks.
// - Every page is real HTML (a <div> per line, a <span> per run) and all pages live inside one
//   editable element (#doc), so selections can span pages. Simple typing is left to the
//   browser and read back afterwards; anything that could cross a page boundary (Enter, paste,
//   deleting a selection, Backspace at the top of a page, styling) edits the stored runs and
//   re-renders.
// - To split pages and to export, an off-screen copy of a page is laid out, the exact position
//   of every character is read back, and the text is drawn at those positions on a canvas.

const BODY = { font: 'EB Garamond', size: 36, color: '#1a1a1a', bold: false, italic: false, align: 'left' };

const POEM = `"Hope" is the thing with feathers -
That perches in the soul -
And sings the tune without the words -
And never stops - at all -

And sweetest - in the Gale - is heard -
And sore must be the storm -
That could abash the little Bird
That kept so many warm -

I've heard it in the chillest land -
And on the strangest Sea -
Yet - never - in Extremity,
It asked a crumb - of me.`;

const DEFAULT_SECTIONS = [[
  { t: 'Hope is the thing with feathers\n', ...BODY, size: 48 },
  { t: 'Emily Dickinson', ...BODY, size: 28, italic: true },
  { t: '\n\n' + POEM, ...BODY },
]];

const DEFAULTS = {
  sections: DEFAULT_SECTIONS,
  wrapWidth: 840, hang: 40, lineHeight: 1.5,
  mt: 120, mr: 120, mb: 120, ml: 120, linkMargins: true, flowSameAsTop: true, keepStanzas: true,
  preset: '1080x1350', width: 1080, height: 1350,
  bg: '#faf8f3', transparent: false, pageNumbers: false,
  scale: '2', format: 'png', quality: 0.92,
};

const STORAGE_KEY = 'poem-typesetter';
const MARGINS = ['mt', 'mr', 'ml'];
const THUMB_H = 120;

const $ = (id) => document.getElementById(id);
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const docEl = $('doc');
const inputs = document.querySelectorAll('[data-key]');
const styleInputs = document.querySelectorAll('[data-style]');
const measureCtx = document.createElement('canvas').getContext('2d');

let s;                 // settings + text, loaded at startup (bottom of file)
let pages = [];        // derived: { sec, start, end, runs, text, m: { lines, overflowAt } }
let rendered = [];     // per page in #doc: { newSection, sep } (sep = runs between it and the previous page)
let sel = 0;           // page with the caret
let lastRange = null;  // last selection in the editor (see docSelection)
let pending = null;    // style for the next typed text: { si, g, patch }
let composing = false; // don't touch the editor mid-IME composition

// ---------- runs ----------

const KEYS = ['font', 'size', 'color', 'bold', 'italic', 'align'];
const sameStyle = (a, b) => KEYS.every((k) => a[k] === b[k]);
const styleOf = (r) => Object.fromEntries(KEYS.map((k) => [k, r[k]]));
const plain = (runs) => runs.map((r) => r.t).join('');
const sig = (runs) => JSON.stringify(runs.map((r) => [r.t, ...KEYS.map((k) => r[k])]));
const samePos = (a, b) => !!a && !!b && a.si === b.si && a.g === b.g;

// Drop empty runs and merge neighbours with the same style.
function norm(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.t += r.t; else out.push({ ...r });
  }
  return out;
}

// Runs covering characters [a, b).
function sliceRuns(runs, a, b = Infinity) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const s0 = pos, e0 = pos + r.t.length;
    pos = e0;
    const x = Math.max(a, s0), y = Math.min(b, e0);
    if (x < y) out.push({ ...r, t: r.t.slice(x - s0, y - s0) });
  }
  return out;
}

function restyle(runs, a, b, patch) {
  return norm([...sliceRuns(runs, 0, a), ...sliceRuns(runs, a, b).map((r) => ({ ...r, ...patch })), ...sliceRuns(runs, b)]);
}

function styleAt(runs, i) {
  let pos = 0;
  for (const r of runs) {
    pos += r.t.length;
    if (i < pos) return styleOf(r);
  }
  return runs.length ? styleOf(runs[runs.length - 1]) : baseStyle();
}

// Lines: [{ runs, align }]. A line's alignment is its first character's (or, for an empty
// line, the line break before it).
function splitLines(runs) {
  const lines = [{ runs: [], nlAlign: null }];
  for (const r of runs) {
    r.t.split('\n').forEach((part, k) => {
      if (k) lines.push({ runs: [], nlAlign: r.align });
      if (part) lines[lines.length - 1].runs.push({ ...r, t: part });
    });
  }
  for (const ln of lines) ln.align = ln.runs[0]?.align || ln.nlAlign || 'left';
  return lines;
}

// Join lines back into runs. Each "\n" takes the style of the character before it and the
// alignment of the line after it, so the same text always has the same representation.
function linesToRuns(lines) {
  const runs = [];
  lines.forEach((ln, i) => {
    if (i) {
      const prev = runs[runs.length - 1];
      runs.push({ ...(prev ? styleOf(prev) : baseStyle()), t: '\n', align: ln.align });
    }
    for (const r of ln.runs) runs.push({ ...r, align: ln.align });
  });
  return norm(runs);
}

const canon = (runs) => linesToRuns(splitLines(runs));

// The smallest text in the document sets each line's minimum height, so small text
// isn't spaced as if it were big. Used for both the editor and the measurer.
function baseStyle() {
  const all = s.sections.flat();
  if (!all.length) return { ...BODY };
  return styleOf(all.reduce((a, b) => (b.size < a.size ? b : a)));
}

function fontStr(st) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${st.size}px "${st.font}"`;
}

function cssFor(st) {
  return `font-family:"${st.font}", serif;font-size:${st.size}px;color:${st.color};` +
    `font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? 'italic' : 'normal'}`;
}

function rgbToHex(rgb) {
  const m = rgb.match(/\d+(\.\d+)?/g) || [0, 0, 0];
  return '#' + m.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('');
}

// ---------- settings ----------

function freshDefaults() { return { ...DEFAULTS, sections: structuredClone(DEFAULT_SECTIONS) }; }

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
  // Migrate from older versions (plain-text pages/sections plus global title/author/font settings).
  let strings = null;
  if (saved.text && !saved.sections) strings = saved.text.split(/\n?^\s*---page---\s*$\n?/m);
  else if (saved.pages && !saved.sections) strings = [saved.pages.join('\n\n')];
  else if (Array.isArray(saved.sections) && typeof saved.sections[0] === 'string') strings = saved.sections;
  if (strings) {
    const st = { font: saved.font || BODY.font, size: saved.size || BODY.size, color: saved.color || BODY.color,
      bold: saved.weight === '700', italic: !!saved.italic };
    const sections = strings.map((t) => (t ? [{ t, ...st }] : []));
    const head = [];
    if (saved.title?.trim()) head.push({ t: saved.title, ...st, size: saved.titleSize || 48 });
    if (saved.author?.trim()) {
      if (head.length) head.push({ t: '\n', ...st, size: saved.titleSize || 48 });
      head.push({ t: saved.author, ...st, size: saved.authorSize || 28 });
    }
    if (head.length) sections[0] = [...head, { t: '\n\n', ...st }, ...sections[0]];
    saved.sections = sections;
  }
  if (Array.isArray(saved.sections)) {
    saved.sections = saved.sections.map((runs) => runs.map((r) => ({ ...r, align: r.align || saved.align || 'left' })));
  }
  for (const k of ['text', 'pages', 'title', 'author', 'font', 'size', 'weight', 'italic', 'color', 'titleSize', 'authorSize', 'align']) {
    delete saved[k];
  }
  const out = { ...freshDefaults(), ...saved };
  if (!Array.isArray(out.sections) || !out.sections.length) out.sections = [[]];
  return out;
}

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}

function writeInputs(force = false) {
  inputs.forEach((el) => {
    if (!force && el === document.activeElement) return;
    const v = s[el.dataset.key];
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  });
  const flow = document.querySelector('[data-key=mb]');
  flow.disabled = s.flowSameAsTop;
  if (s.flowSameAsTop) flow.value = s.mt;
  syncHex();
}

// Distance from the bottom of the page where text flows to the next page.
const bottom = () => (s.flowSameAsTop ? s.mt : s.mb);

function presetFor(w, h) {
  const v = `${w}x${h}`;
  return [...document.querySelectorAll('[data-key=preset] option')].some((o) => o.value === v) ? v : 'custom';
}

// Number boxes apply on 'change' (Enter, leaving the box, or the arrows), not on every
// keystroke, so typing 1080 -> 1200 doesn't re-lay-out a long poem at 108 and 120 on the way.
inputs.forEach((el) => el.addEventListener(el.type === 'number' ? 'change' : 'input', () => {
  const k = el.dataset.key;
  const v = readInput(el);
  if (v === null || Number.isNaN(v)) return; // ignore half-typed numbers
  s[k] = v;
  if (s.linkMargins && MARGINS.includes(k)) MARGINS.forEach((m) => { s[m] = v; });
  if (k === 'preset' && v !== 'custom') [s.width, s.height] = v.split('x').map(Number);
  if (k === 'width' || k === 'height') s.preset = presetFor(s.width, s.height);
  if (k === 'flowSameAsTop' && !v) s.mb = s.mt; // start editing from the current value
  writeInputs();
  save();
  scheduleRefresh(true);
}));

// ---------- page DOM (shared by editor and measurer) ----------

const numSize = () => Math.round(baseStyle().size * 0.6);

function applyPageVars(page) {
  const base = baseStyle();
  const all = s.sections.flat();
  const vars = {
    w: s.width + 'px', h: s.height + 'px',
    mt: s.mt + 'px', mr: s.mr + 'px', mb: bottom() + 'px', ml: s.ml + 'px',
    bg: s.bg, color: all.length ? all[all.length - 1].color : BODY.color,
    font: `"${base.font}", serif`,
    wrap: Math.max(50, Math.min(s.wrapWidth, s.width - s.ml - s.mr)) + 'px',
    numSize: numSize() + 'px', lh: s.lineHeight, hang: s.hang + 'px',
  };
  for (const [k, v] of Object.entries(vars)) page.style.setProperty('--' + k, v);
  page.classList.toggle('transparent', s.transparent && s.format === 'png');
}

// One <div class="ln"> per line, one <span> per run. data-o = offset of the span in the page text.
function fillRuns(el, runs) {
  el.innerHTML = '';
  let o = 0;
  splitLines(runs).forEach((ln, i) => {
    if (i) o += 1;
    const div = make('div', 'ln');
    div.style.textAlign = ln.align;
    if (!ln.runs.length) div.append(make('br'));
    for (const r of ln.runs) {
      const span = make('span', null, r.t);
      span.style.cssText = cssFor(r);
      span.dataset.o = o;
      span.dataset.font = fontStr(r);
      o += r.t.length;
      div.append(span);
    }
    el.append(div);
  });
}

function buildPage(runs, numText) {
  const page = make('div', 'page');
  const block = make('div', 'block');
  const poem = make('div', 'poem');
  poem.style.cssText = cssFor(baseStyle());
  fillRuns(poem, runs);
  block.append(poem);
  page.append(block);
  if (numText) {
    const num = make('div', 'pagenum', numText);
    num.contentEditable = 'false';
    page.append(num);
  }
  applyPageVars(page);
  return page;
}

// ---------- measuring & pagination ----------

const ascentCache = new Map();
function ascent(font) {
  if (!ascentCache.has(font)) {
    measureCtx.font = font;
    ascentCache.set(font, measureCtx.measureText('Hg').fontBoundingBoxAscent);
  }
  return ascentCache.get(font);
}

// Lay out runs on an off-screen page and read back every visual line: where it starts in the
// text, how far down it reaches, and its pieces of same-style text with their positions.
function measureRuns(runs) {
  const box = $('measure');
  box.innerHTML = '';
  const page = buildPage(runs, null);
  box.append(page);
  const base = page.getBoundingClientRect();
  const range = document.createRange();
  const lines = [];
  page.querySelectorAll('.ln').forEach((ln) => {
    let cur = null, seg = null, hard = true, lastRight = 0;
    ln.querySelectorAll('span').forEach((span) => {
      const node = span.firstChild;
      const font = span.dataset.font;
      const o = Number(span.dataset.o);
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getClientRects()[0];
        if (!r) continue;
        const top = r.top - base.top, bot = r.bottom - base.top;
        // A soft wrap shows up as text jumping back to the left (or down below the line).
        if (!cur || r.left < lastRight - 1 || top >= cur.bottom - 1) {
          if (!hard && /\s/.test(node.data[i])) continue; // space swallowed at a soft wrap
          cur = { start: o + i, bottom: bot, segs: [] };
          lines.push(cur);
          seg = null;
          hard = false;
        }
        if (!seg || seg.span !== span) {
          seg = { span, text: '', x: r.left - base.left, y: top + ascent(font), font, color: span.style.color };
          cur.segs.push(seg);
        }
        seg.text += node.data[i];
        cur.bottom = Math.max(cur.bottom, bot);
        lastRight = r.right;
      }
    });
  });
  lines.forEach((l) => l.segs.forEach((g) => delete g.span));
  const limit = s.height - bottom() + 1;
  const over = lines.find((l) => l.bottom > limit);
  return { lines, overflowAt: over ? over.start : -1 };
}

// Where to split text, given the index of the first line that doesn't fit.
// Prefers the start of the stanza (unless "Keep stanzas together" is off), then the start of
// the line, then mid-line.
// Returns { headEnd, tailStart }, or null if nothing fits (e.g. text bigger than the page).
function findCut(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  const before = text.slice(0, lineStart);
  if (before.trim()) {
    const blanks = s.keepStanzas ? [...before.matchAll(/\n[ \t]*(?=\n)/g)] : [];
    const last = blanks[blanks.length - 1];
    if (last && text.slice(0, last.index).trim()) {
      return { headEnd: last.index, tailStart: text.indexOf('\n', last.index + 1) + 1 };
    }
    return { headEnd: lineStart - 1, tailStart: lineStart };
  }
  // The first line alone is taller than the page: split it where it stops fitting.
  if (!text.slice(0, idx).trim()) return null;
  let t = idx;
  while (text[t] === ' ') t++;
  return { headEnd: idx, tailStart: t };
}

function paginate() {
  const out = [];
  s.sections.forEach((runs, si) => {
    const total = plain(runs).length;
    let start = 0;
    while (out.length < 1000) {
      const rest = sliceRuns(runs, start);
      const restText = plain(rest);
      const m = measureRuns(rest);
      const cut = m.overflowAt >= 0 ? findCut(restText, m.overflowAt) : null;
      if (!cut) { out.push({ sec: si, start, end: total, runs: rest, text: restText, m }); break; }
      const head = sliceRuns(rest, 0, cut.headEnd);
      out.push({ sec: si, start, end: start + cut.headEnd, runs: head, text: plain(head), m: measureRuns(head) });
      start += cut.tailStart;
    }
  });
  return out;
}

async function fontsReady() {
  const all = s.sections.flat();
  const sample = plain(all) + '0123456789/';
  const fonts = new Set([...all.map(fontStr), fontStr(baseStyle()), fontStr({ ...baseStyle(), size: numSize() })]);
  await Promise.all([...fonts].map((f) => document.fonts.load(f, sample).catch(() => {})));
}

// ---------- drawing ----------

function drawPage(canvas, pxScale, i) {
  canvas.width = Math.max(1, Math.round(s.width * pxScale));
  canvas.height = Math.max(1, Math.round(s.height * pxScale));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pxScale, 0, 0, pxScale, 0, 0);
  if (!(s.transparent && s.format === 'png')) {
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, s.width, s.height);
  }
  ctx.textBaseline = 'alphabetic';
  for (const line of pages[i].m.lines) {
    for (const seg of line.segs) {
      ctx.font = seg.font;
      ctx.fillStyle = seg.color;
      ctx.fillText(seg.text, seg.x, seg.y);
    }
  }
  if (s.pageNumbers && pages.length > 1) {
    const all = s.sections.flat();
    ctx.font = fontStr({ ...baseStyle(), size: numSize() });
    ctx.fillStyle = all.length ? all[all.length - 1].color : BODY.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${i + 1} / ${pages.length}`, s.width / 2, s.height - bottom() / 2);
  }
}

// ---------- reading the editor ----------

const ALIGN = { center: 'center', '-webkit-center': 'center', right: 'right', end: 'right', '-webkit-right': 'right' };

function computedStyle(el) {
  const c = getComputedStyle(el);
  return {
    font: c.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
    size: Math.round(parseFloat(c.fontSize) * 100) / 100,
    color: rgbToHex(c.color),
    bold: Number(c.fontWeight) >= 600,
    italic: c.fontStyle === 'italic',
    align: ALIGN[c.textAlign] || 'left',
  };
}

// Walk a page's DOM, whatever elements the browser created while editing, and split it into
// lines (block elements and <br>s end lines). With `styled`, each piece of text gets its
// actual style. "Anchors" map DOM positions to offsets in the page text.
function collectLines(root, styled) {
  const lines = [], anchors = [];
  let cur = null, count = 0;
  const startLine = (align) => {
    if (lines.length) count += 1;
    cur = { runs: [], align };
    lines.push(cur);
  };
  const walk = (node) => node.childNodes.forEach((ch, idx) => {
    if (ch.nodeType === Node.TEXT_NODE) {
      const st = styled ? computedStyle(ch.parentElement) : {};
      let pos = 0;
      ch.data.split('\n').forEach((part, k) => {
        if (k) { cur = null; pos += 1; }
        if (!part) return;
        if (!cur) startLine(st.align);
        anchors.push({ node: ch, pos, count, len: part.length });
        cur.runs.push({ t: part.replace(/\u00a0/g, ' '), ...st });
        count += part.length;
        pos += part.length;
      });
    } else if (ch.nodeType === Node.ELEMENT_NODE) {
      if (ch.classList.contains('pagenum')) return;
      if (ch.nodeName === 'BR') {
        if (!cur) {
          startLine(styled ? computedStyle(node).align : undefined);
          anchors.push({ node, pos: idx, count, len: 0, el: true });
        }
        cur = null;
      } else if (ch.nodeName === 'DIV' || ch.nodeName === 'P') {
        cur = null;
        walk(ch);
        cur = null;
      } else walk(ch);
    }
  });
  walk(root);
  return { lines, anchors, len: count };
}

const pageEls = () => [...docEl.children].filter((e) => e.classList.contains('page'));
const readPage = (pg) => linesToRuns(collectLines(pg, true).lines);

// Rebuild all sections from the editor, re-inserting the text between pages that isn't shown.
function readDoc() {
  const sections = [];
  pageEls().forEach((pg, i) => {
    const runs = readPage(pg);
    if (rendered[i].newSection || !sections.length) sections.push(runs);
    else sections[sections.length - 1] = norm([...sections[sections.length - 1], ...rendered[i].sep, ...runs]);
  });
  return sections;
}

// Where each page's text starts in its section, from the current editor contents.
function pageStarts() {
  const out = [];
  pageEls().forEach((pg, i) => {
    const len = collectLines(pg, false).len;
    const prev = out[out.length - 1];
    if (rendered[i].newSection || !prev) out.push({ si: prev ? prev.si + 1 : 0, g: 0, len });
    else out.push({ si: prev.si, g: prev.g + prev.len + plain(rendered[i].sep).length, len });
  });
  return out;
}

// Convert a DOM position in the editor to { si, g, page, local }.
function posFromDom(node, offset, starts) {
  const els = pageEls();
  let pg, local;
  if (node === docEl) {
    pg = els[Math.min(offset, els.length - 1)];
    local = offset >= els.length ? collectLines(pg, false).len : 0;
  } else {
    pg = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('.page');
    if (!pg || pg.parentElement !== docEl) return null;
    const { anchors, len } = collectLines(pg, false);
    const probe = document.createRange();
    let prevEnd = null;
    local = len;
    for (const a of anchors) {
      if (!a.el && a.node === node && offset >= a.pos && offset <= a.pos + a.len) { local = a.count + offset - a.pos; break; }
      probe.setStart(a.node, a.pos);
      probe.collapse(true);
      if (probe.comparePoint(node, offset) <= 0) {
        // Before this anchor: the start of its line, or the end of the previous line.
        const line = (a.el ? a.node : a.node.parentElement).closest('div');
        local = prevEnd !== null && !(line && line.contains(node)) ? prevEnd : a.count;
        break;
      }
      prevEnd = a.count + a.len;
    }
  }
  const page = els.indexOf(pg);
  const st = starts[page];
  return { si: st.si, g: st.g + local, page, local };
}

// The editor selection as { A, B } (A before B), each { si, g, page, local }.
function docSelection() {
  const sl = getSelection();
  if (!sl.rangeCount || !docEl.contains(sl.anchorNode) || !rendered.length) return null;
  const starts = pageStarts();
  const x = posFromDom(sl.anchorNode, sl.anchorOffset, starts);
  const y = posFromDom(sl.focusNode, sl.focusOffset, starts);
  if (!x || !y) return null;
  const xFirst = x.si < y.si || (x.si === y.si && x.g <= y.g);
  return { A: xFirst ? x : y, B: xFirst ? y : x, focus: y, collapsed: x.si === y.si && x.g === y.g };
}

// ---------- writing to the editor ----------

// Model position -> DOM position in the rendered editor.
function domPoint(pos) {
  const els = pageEls();
  let i = pages.findIndex((p) => p.sec === pos.si && pos.g <= p.end);
  if (i < 0) i = pages.length - 1;
  const p = pages[i];
  const local = Math.max(0, Math.min(pos.g - p.start, p.text.length));
  const { anchors } = collectLines(els[i], false);
  for (const a of anchors) {
    if (local <= a.count + a.len) return a.el ? [a.node, a.pos] : [a.node, a.pos + Math.max(0, local - a.count)];
  }
  const last = anchors[anchors.length - 1];
  if (!last) return [els[i].querySelector('.ln') || els[i], 0];
  return last.el ? [last.node, last.pos] : [last.node, last.pos + last.len];
}

function setSelection(A, B = A) {
  docEl.focus({ preventScroll: true });
  const r = document.createRange();
  r.setStart(...domPoint(A));
  r.setEnd(...domPoint(B));
  getSelection().removeAllRanges();
  getSelection().addRange(r);
}

// Replace the text between positions A and B (possibly in different sections) with `ins`.
function replaceRange(A, B, ins) {
  const left = sliceRuns(s.sections[A.si], 0, A.g);
  const right = sliceRuns(s.sections[B.si], B.g);
  s.sections.splice(A.si, B.si - A.si + 1, norm([...left, ...ins, ...right]));
  return { si: A.si, g: A.g + plain(ins).length };
}

function restyleRange(A, B, patch) {
  for (let si = A.si; si <= B.si; si++) {
    s.sections[si] = restyle(s.sections[si], si === A.si ? A.g : 0, si === B.si ? B.g : Infinity, patch);
  }
}

function rangeRuns(A, B) {
  const out = [];
  for (let si = A.si; si <= B.si; si++) {
    out.push(...sliceRuns(s.sections[si], si === A.si ? A.g : 0, si === B.si ? B.g : Infinity));
  }
  return out;
}

// Style for text typed at a position: the character before it, or the one after at a line
// start, plus any pending style.
function styleAtPos(A) {
  const runs = s.sections[A.si];
  const text = plain(runs);
  const i = A.g > 0 && text[A.g - 1] !== '\n' ? A.g - 1 : Math.min(A.g, text.length - 1);
  return { ...styleAt(runs, Math.max(0, i)), ...(samePos(pending, A) ? pending.patch : {}) };
}

function insertText(text, r) {
  s.sections = readDoc();
  const st = styleAtPos(r.A);
  pending = null;
  const caret = replaceRange(r.A, r.B, text ? [{ ...st, t: text }] : []);
  commit({ caret });
}

// Backspace at the top of page `i` (or Delete at the bottom of page i-1).
function joinPages(i, starts) {
  s.sections = readDoc();
  const st = starts[i];
  let caret;
  if (st.g > 0) {
    // Automatic break: delete the character before this page, like any other backspace.
    caret = replaceRange({ si: st.si, g: st.g - 1 }, st, []);
  } else {
    // Page added with "+ Add page": merge it into the previous section as a new stanza.
    const prevRuns = s.sections[st.si - 1];
    const keep = plain(prevRuns).trimEnd().length;
    const prev = sliceRuns(prevRuns, 0, keep);
    const joiner = keep && plain(s.sections[st.si]).trim() ? [{ ...styleAt(prev, keep - 1), t: '\n\n' }] : [];
    s.sections[st.si - 1] = norm([...prev, ...joiner, ...s.sections[st.si]]);
    s.sections.splice(st.si, 1);
    caret = { si: st.si - 1, g: keep + (joiner.length ? 2 : 0) };
  }
  commit({ caret });
}

// Apply a style change (from the sidebar or a shortcut) to the selection `r`.
function applyStyle(patch, r) {
  if ('align' in patch) {
    // Alignment applies to whole lines.
    const a = plain(s.sections[r.A.si]), b = plain(s.sections[r.B.si]);
    const e = b.indexOf('\n', r.B.g);
    restyleRange({ si: r.A.si, g: a.lastIndexOf('\n', r.A.g - 1) + 1 }, { si: r.B.si, g: e < 0 ? b.length : e }, patch);
    commit({ caret: r.A, caret2: r.B });
    return;
  }
  if (r.collapsed) {
    // Nothing selected: style what's typed next.
    pending = { si: r.A.si, g: r.A.g, patch: { ...(samePos(pending, r.A) ? pending.patch : {}), ...patch } };
    showStyle(styleAtPos(r.A));
    return;
  }
  restyleRange(r.A, r.B, patch);
  commit({ caret: r.A, caret2: r.B });
}

function toggle(prop) {
  const r = docSelection();
  if (!r) return;
  s.sections = readDoc();
  const on = r.collapsed ? styleAtPos(r.A)[prop]
    : rangeRuns(r.A, r.B).filter((x) => x.t.trim()).every((x) => x[prop]);
  applyStyle({ [prop]: !on }, r);
}

// ---------- editor events ----------

docEl.addEventListener('input', () => {
  if (composing || !rendered.length) return;
  s.sections = readDoc();
  save();
  scheduleRefresh(false);
});
docEl.addEventListener('compositionstart', () => { composing = true; });
docEl.addEventListener('compositionend', () => { composing = false; docEl.dispatchEvent(new Event('input')); });

docEl.addEventListener('beforeinput', (e) => {
  const t = e.inputType;
  // Formatting comes from our own shortcuts and the sidebar; undo is our own too.
  if (t.startsWith('format') || t.startsWith('history') || t === 'insertFromDrop' || t === 'deleteByDrag') {
    e.preventDefault();
    return;
  }
  if (composing || t === 'insertCompositionText') return;
  const r = docSelection();
  if (!r) return;
  if (t === 'insertParagraph' || t === 'insertLineBreak') { e.preventDefault(); insertText('\n', r); return; }
  if (!r.collapsed) {
    // Anything replacing a selection is done on the stored text, since it may span pages.
    if (t.startsWith('insert')) { e.preventDefault(); insertText(e.data ?? '', r); }
    else if (t.startsWith('delete')) { e.preventDefault(); insertText('', r); }
    return;
  }
  if (t === 'insertText' && samePos(pending, r.A)) { e.preventDefault(); insertText(e.data, r); return; }
  if (!t.startsWith('delete')) return;
  const starts = pageStarts();
  if (t.endsWith('Backward') && r.A.local === 0 && r.A.page > 0) {
    e.preventDefault();
    joinPages(r.A.page, starts);
  } else if (t.endsWith('Forward') && r.A.local === starts[r.A.page].len && r.A.page < pages.length - 1) {
    e.preventDefault();
    joinPages(r.A.page + 1, starts);
  }
});

docEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const r = docSelection();
  if (r) insertText(e.clipboardData.getData('text/plain').replace(/\r/g, '').replace(/\t/g, '    '), r);
});
const copyText = (e) => {
  const r = docSelection();
  if (!r || r.collapsed) return null;
  e.preventDefault();
  s.sections = readDoc();
  e.clipboardData.setData('text/plain', plain(rangeRuns(r.A, r.B)));
  return r;
};
docEl.addEventListener('copy', copyText);
docEl.addEventListener('cut', (e) => { const r = copyText(e); if (r) insertText('', r); });

docEl.addEventListener('keydown', (e) => {
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'b' || k === 'i')) { e.preventDefault(); toggle(k === 'b' ? 'bold' : 'italic'); }
  else if (mod && k === 'z') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); }
  else if (mod && k === 'y') { e.preventDefault(); undo(1); }
  else if (e.key === 'Tab') { e.preventDefault(); const r = docSelection(); if (r) insertText('    ', r); }
});

// Clicking a page's margin puts the caret at the end of that page's text.
docEl.addEventListener('mousedown', (e) => {
  const t = e.target;
  if (t === docEl) { e.preventDefault(); return; }
  if (t.classList.contains('page') || t.classList.contains('block') || t.classList.contains('poem')) {
    e.preventDefault();
    const i = pageEls().indexOf(t.closest('.page'));
    if (i >= 0) setSelection({ si: pages[i].sec, g: pages[i].end });
  }
});

document.addEventListener('selectionchange', () => {
  const r = docSelection();
  if (!r) return;
  lastRange = r;
  if (pending && !(r.collapsed && samePos(pending, r.A))) pending = null;
  if (sel !== r.focus.page) {
    sel = r.focus.page;
    [...$('carousel').querySelectorAll('.thumb')].forEach((t, j) => t.classList.toggle('selected', j === sel));
  }
  const node = getSelection().focusNode;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  showStyle({ ...computedStyle(el), ...(pending ? pending.patch : {}) });
});

// ---------- text style controls ----------

function showStyle(st) {
  styleInputs.forEach((el) => {
    if (el === document.activeElement) return;
    const v = st[el.dataset.style];
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  });
  syncHex();
}

// Styles apply live while you use a control. Focus stays in the sidebar (so you can keep
// typing a size or dragging the color picker); the selection is remembered in `lastRange`
// and stays highlighted on the page.
let stylePatch = null;
styleInputs.forEach((el) => el.addEventListener('input', () => {
  const k = el.dataset.style;
  const v = readInput(el);
  if (k === 'size' && !(v >= 4 && v <= 400)) return; // e.g. the "1" while typing "18"
  // Coalesce rapid changes (dragging the color picker) into one update per frame.
  if (!stylePatch) setTimeout(flushStyle, 16);
  stylePatch = { ...stylePatch, [k]: v };
}));

function flushStyle() {
  const patch = stylePatch;
  stylePatch = null;
  s.sections = readDoc();
  if ($('styleScope').value === 'all') {
    s.sections = s.sections.map((runs) => norm(runs.map((r) => ({ ...r, ...patch }))));
    commit({});
    return;
  }
  if (!lastRange) {
    $('styleHint').classList.add('flash');
    setTimeout(() => $('styleHint').classList.remove('flash'), 1200);
    return;
  }
  applyStyle(patch, lastRange);
}

// Bold/italic checkboxes don't take focus, so the page keeps its live selection.
document.querySelectorAll('[data-style=bold], [data-style=italic]').forEach((el) => {
  el.closest('label').addEventListener('mousedown', (e) => e.preventDefault());
});

// While focus is outside the page, keep showing the remembered selection.
function showSavedSelection(range) {
  if (!window.Highlight || !CSS.highlights) return;
  CSS.highlights.delete('saved');
  if (document.activeElement === docEl || !lastRange || lastRange.collapsed) return;
  if (!range) {
    range = document.createRange();
    range.setStart(...domPoint(lastRange.A));
    range.setEnd(...domPoint(lastRange.B));
  }
  CSS.highlights.set('saved', new Highlight(range));
}
docEl.addEventListener('blur', () => {
  const sl = getSelection();
  showSavedSelection(sl.rangeCount && docEl.contains(sl.anchorNode) ? sl.getRangeAt(0).cloneRange() : null);
});
docEl.addEventListener('focus', () => CSS.highlights?.delete('saved'));

// ---------- carousel ----------

function buildCarousel() {
  const c = $('carousel');
  c.innerHTML = '';
  pages.forEach((p, i) => {
    const t = make('div', 'thumb');
    const canvas = make('canvas');
    drawPage(canvas, (THUMB_H * (window.devicePixelRatio || 1)) / s.height, i);
    t.append(canvas, make('div', null, `Page ${i + 1}`));
    t.classList.toggle('selected', i === sel);
    t.classList.toggle('overflow', p.m.overflowAt >= 0);
    if (pages.length > 1) {
      const del = make('button', 'del', '×');
      del.title = 'Delete page';
      del.addEventListener('click', (e) => { e.stopPropagation(); deletePage(i); });
      t.append(del);
    }
    t.addEventListener('click', () => {
      pageEls()[i].scrollIntoView({ block: 'start', behavior: 'smooth' });
      setSelection({ si: p.sec, g: p.start });
    });
    c.append(t);
  });
  const add = make('button', 'add', '+ Add page');
  add.addEventListener('click', addPage);
  c.append(add);
}

function addPage() {
  s.sections = readDoc();
  s.sections.push([]);
  commit({ caret: { si: s.sections.length - 1, g: 0 } });
  pageEls().at(-1).scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('carousel').lastChild.scrollIntoView({ inline: 'end' });
}

function deletePage(i) {
  const p = pages[i];
  if (p.text.trim() && !confirm(`Delete page ${i + 1} and its text?`)) return;
  s.sections = readDoc();
  const sec = s.sections[p.sec];
  const next = pages[i + 1];
  const end = next && next.sec === p.sec ? next.start : plain(sec).length;
  const rest = norm([...sliceRuns(sec, 0, p.start), ...sliceRuns(sec, end)]);
  if (!plain(rest).trim() && s.sections.length > 1) s.sections.splice(p.sec, 1);
  else s.sections[p.sec] = plain(rest).trim() ? rest : [];
  sel = Math.max(0, Math.min(sel, pages.length - 2));
  commit({});
}

// ---------- undo ----------

// Up to 2000 steps, but never more than ~100 MB of snapshots (only matters for huge poems).
const HIST_STEPS = 2000, HIST_CHARS = 50e6; // JS strings are 2 bytes/char
let hist = [], hi = -1, histChars = 0;

function checkpoint() {
  const j = JSON.stringify(s.sections);
  if (hist[hi] === j) return;
  for (const old of hist.splice(hi + 1)) histChars -= old.length; // drop the redo branch
  hist.push(j);
  histChars += j.length;
  while (hist.length > 1 && (hist.length > HIST_STEPS || histChars > HIST_CHARS)) histChars -= hist.shift().length;
  hi = hist.length - 1;
}

function undo(dir) {
  clearTimeout(timer);
  s.sections = readDoc().map(canon);
  checkpoint(); // keep any typing that hasn't been recorded yet
  const n = hi + dir;
  if (n < 0 || n >= hist.length) return;
  const before = s.sections;
  hi = n;
  s.sections = JSON.parse(hist[hi]);
  // Put the caret where the text changed.
  let caret = { si: 0, g: 0 };
  for (let si = 0; si < Math.max(before.length, s.sections.length); si++) {
    const a = plain(before[si] || []), b = plain(s.sections[si] || []);
    if (a !== b) {
      let g = 0;
      while (g < a.length && a[g] === b[g]) g++;
      caret = { si: Math.min(si, s.sections.length - 1), g: Math.min(g, b.length) };
      break;
    }
  }
  commit({ caret });
}

// ---------- refresh ----------

let timer, pendingForce = false;

function scheduleRefresh(force) {
  pendingForce = pendingForce || force;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const f = pendingForce;
    pendingForce = false;
    refresh({ force: f });
  }, 150);
}

async function refresh(opts = {}) {
  await fontsReady();
  rebuild(opts);
}

// After a change to the stored text: save, re-render right away (so fast typing can't race
// it), then refresh again once any new fonts have loaded.
function commit(opts) {
  save();
  rebuild({ ...opts, force: true });
  scheduleRefresh(false);
}

// Re-split sections into pages. Re-render the editor only if the pages changed, keeping the
// selection with its text.
function rebuild({ caret = null, caret2 = null, force = false } = {}) {
  if (composing) return;
  if (!caret && document.activeElement === docEl) {
    const r = docSelection();
    if (r) { caret = r.A; caret2 = r.B; }
  }
  s.sections = s.sections.map(canon);
  pages = paginate();
  const els = pageEls();
  const seps = pages.map((p, i) => (i && pages[i - 1].sec === p.sec ? sliceRuns(s.sections[p.sec], pages[i - 1].end, p.start) : []));
  const dirty = force || els.length !== pages.length || pages.some((p, i) =>
    rendered[i]?.newSection !== (p.start === 0) || sig(rendered[i].sep) !== sig(seps[i]) ||
    sig(readPage(els[i])) !== sig(canon(p.runs)));
  if (dirty) {
    docEl.innerHTML = '';
    pages.forEach((p, i) => {
      const page = buildPage(p.runs, s.pageNumbers && pages.length > 1 ? `${i + 1} / ${pages.length}` : null);
      page.classList.toggle('overflow', p.m.overflowAt >= 0);
      docEl.append(page);
    });
    rendered = pages.map((p, i) => ({ newSection: p.start === 0, sep: seps[i] }));
    fitEditor();
    if (caret && document.activeElement === docEl) setSelection(caret, caret2 || caret);
  } else {
    els.forEach((el, i) => el.classList.toggle('overflow', pages[i].m.overflowAt >= 0));
  }
  if (caret) {
    const i = pages.findIndex((p) => p.sec === caret.si && caret.g <= p.end);
    sel = i < 0 ? pages.length - 1 : i;
  }
  sel = Math.max(0, Math.min(sel, pages.length - 1));
  if (caret && document.activeElement !== docEl) {
    const B = caret2 || caret;
    lastRange = { A: caret, B, focus: B, collapsed: samePos(caret, B) };
  }
  showSavedSelection();
  buildCarousel();
  checkpoint();
  const sc = Number(s.scale), n = pages.length;
  $('info').textContent =
    `Output: ${Math.round(s.width * sc)} × ${Math.round(s.height * sc)} px · ${n} page${n > 1 ? 's' : ''}`;
}

function fitEditor() {
  // Show one whole page at a time; scroll for the rest.
  const stage = $('stage');
  docEl.style.zoom = Math.min(1, (stage.clientWidth - 48) / s.width, (stage.clientHeight - 48) / s.height);
}

// ---------- export ----------

function slug() {
  const first = plain(s.sections.flat()).trim().split('\n')[0] || 'poem';
  return first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'poem';
}

function fileName(i) {
  const ext = s.format === 'jpeg' ? 'jpg' : 'png';
  return pages.length > 1 ? `${slug()}-${String(i + 1).padStart(2, '0')}.${ext}` : `${slug()}.${ext}`;
}

function renderPage(i) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    drawPage(canvas, Number(s.scale), i);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('too large'))),
      s.format === 'jpeg' ? 'image/jpeg' : 'image/png', s.quality);
  });
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Minimal ZIP writer. Files are stored uncompressed: PNG/JPEG are already compressed.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) { // files: [{ name, data: Uint8Array }]
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2],
      [14, crc, 4], [18, size, 4], [22, size, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    const cen = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2],
      [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2],
      [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
    parts.push(local, name, f.data);
    central.push(cen, name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2],
    [12, cenSize, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

async function download(which) {
  clearTimeout(timer);
  s.sections = readDoc();
  await refresh();
  const indices = which === 'all' ? pages.map((_, i) => i) : [sel];
  if (indices.some((i) => pages[i].m.overflowAt >= 0) &&
      !confirm('Some text doesn\'t fit and will be cut off. Download anyway?')) return;
  try {
    if (indices.length === 1) {
      saveBlob(await renderPage(indices[0]), fileName(indices[0]));
      return;
    }
    // Several pages: one .zip with a folder of numbered images.
    const files = [];
    for (const i of indices) {
      files.push({ name: `${slug()}/${fileName(i)}`, data: new Uint8Array(await (await renderPage(i)).arrayBuffer()) });
    }
    saveBlob(makeZip(files), `${slug()}.zip`);
  } catch {
    alert('This image is too large for your browser. Lower the scale or page size.');
  }
}

$('downloadPage').addEventListener('click', () => download('one'));
$('downloadAll').addEventListener('click', () => download('all'));

$('reset').addEventListener('click', () => {
  if (!confirm('Reset all settings and text to defaults?')) return;
  s = freshDefaults();
  sel = 0;
  writeInputs(true);
  commit({});
});

// ---------- hex boxes next to color pickers ----------

// Each color picker gets a text box for typing a hex code. A valid code updates the picker
// and fires its normal 'input' event, so it applies exactly like picking the color.
const hexBoxes = [...document.querySelectorAll('input[type=color]')].map((picker) => {
  const box = make('input', 'hex');
  box.type = 'text';
  box.spellcheck = false;
  box.maxLength = 7;
  box.placeholder = '#000000';
  picker.after(box);
  const parse = (v, full) => {
    let h = v.trim().replace(/^#/, '').toLowerCase();
    if (full && /^[0-9a-f]{3}$/.test(h)) h = h.replace(/./g, (ch) => ch + ch); // #abc -> #aabbcc
    return /^[0-9a-f]{6}$/.test(h) ? '#' + h : null;
  };
  const apply = (full) => {
    const hex = parse(box.value, full);
    box.classList.toggle('bad', !hex && box.value.trim() !== '');
    if (hex && hex !== picker.value) {
      picker.value = hex;
      picker.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (hex && full) box.value = hex;
  };
  box.addEventListener('input', () => apply(false));
  box.addEventListener('change', () => apply(true)); // Enter or leaving the box
  picker.addEventListener('input', () => { box.value = picker.value; box.classList.remove('bad'); });
  return { picker, box };
});

function syncHex() {
  for (const { picker, box } of hexBoxes || []) {
    if (box !== document.activeElement) { box.value = picker.value; box.classList.remove('bad'); }
  }
}

window.addEventListener('resize', fitEditor);

s = loadSettings();
writeInputs(true);
showStyle(BODY);
refresh({ force: true });
