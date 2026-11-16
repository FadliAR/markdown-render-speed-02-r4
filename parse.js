// parse.js — a dependency-free Markdown renderer that mirrors, byte for byte,
// the HTML produced by marked 18.1.3 with its default options (gfm: true,
// breaks: false, pedantic: false). Written from scratch for speed: a
// line-oriented block parser plus a delimiter-stack inline parser.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape a run of literal text (also used for code content, where every
// special character is escaped unconditionally).
function escText(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape an attribute value: like escText, except that an ampersand that
// already introduces an entity reference is left alone.
function escAttr(s) {
  return s
    .replace(/&(?![#a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// marked cleans every URL it emits through encodeURI, undoing any %25 so an
// already-encoded sequence is not encoded twice.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;

function isPunctChar(ch) {
  if (ch === undefined || ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.indexOf(ch) >= 0;
  // CommonMark punctuation = Unicode categories P* and S* (so currency
  // symbols like £ and € count, exactly as ASCII $ does).
  return UNICODE_PUNCT_RE.test(ch);
}

function isSpaceChar(ch) {
  return ch === undefined || ch === '' || /\s/.test(ch);
}

// Windows-1252 replacements for numeric character references in the C1
// range, as the HTML standard prescribes.
const C1_MAP = {
  0x80: 0x20ac, 0x81: 0x0081, 0x82: 0x201a, 0x83: 0x0192,
  0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039,
  0x8c: 0x0152, 0x8d: 0x008d, 0x8e: 0x017d, 0x8f: 0x008f,
  0x90: 0x0090, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9d: 0x009d, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeCodePoint(n) {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  if (n >= 0x80 && n <= 0x9f && C1_MAP[n] !== undefined) {
    return String.fromCodePoint(C1_MAP[n]);
  }
  return String.fromCodePoint(n);
}

// Resolve backslash escapes and numeric character references in a string
// (used for link destinations and titles). Named entities are left as they
// are, matching the reference renderer's behaviour.
function unescapeStr(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.indexOf(s[i + 1]) >= 0) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '&') {
      const m = /^&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/.exec(s.slice(i));
      if (m) {
        const n = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
        out += decodeCodePoint(n);
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column arithmetic (a tab advances to the next multiple of four)
// ---------------------------------------------------------------------------

function leadCols(s) {
  let cols = 0;
  let idx = 0;
  while (idx < s.length) {
    const c = s[idx];
    if (c === ' ') {
      cols++;
      idx++;
    } else if (c === '\t') {
      cols += 4 - (cols % 4);
      idx++;
    } else {
      break;
    }
  }
  return { cols, idx };
}

// The substring of s that begins at column `target`. A tab that straddles
// the target is replaced by the spaces it still owes.
// Remove `cut` columns of leading whitespace from s, where s begins at
// document column `phase` (tab widths depend on it). When the cut disturbs
// tab alignment, the remaining leading whitespace is materialized as
// spaces at its original column widths; otherwise tabs are preserved.
function sliceCols(s, cut, phase) {
  if (phase === undefined) phase = 0;
  if (cut <= 0) return s;
  const target = phase + cut;
  let cols = phase;
  let idx = 0;
  while (idx < s.length && cols < target) {
    const c = s[idx];
    if (c === ' ') {
      cols++;
      idx++;
    } else if (c === '\t') {
      const w = 4 - (cols % 4);
      if (cols + w > target) {
        let total = cols + w;
        let k = idx + 1;
        while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
          total += s[k] === ' ' ? 1 : 4 - (total % 4);
          k++;
        }
        return ' '.repeat(total - target) + s.slice(k);
      }
      cols += w;
      idx++;
    } else {
      break;
    }
  }
  if (cols === target && cut % 4 !== 0) {
    let total = cols;
    let k = idx;
    let hasTab = false;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
      if (s[k] === '\t') {
        hasTab = true;
        total += 4 - (total % 4);
      } else {
        total += 1;
      }
      k++;
    }
    if (hasTab) return ' '.repeat(total - target) + s.slice(k);
  }
  return s.slice(idx);
}

// Remove up to n columns of leading whitespace.
function stripCols(s, n) {
  const lc = leadCols(s);
  if (lc.cols <= n) return s.slice(lc.idx);
  return sliceCols(s, n);
}

function isBlank(s) {
  return /^[ \t]*$/.test(s);
}

// ---------------------------------------------------------------------------
// HTML tag scanning (shared by the block and inline grammars)
// ---------------------------------------------------------------------------

// Scan a tag starting at s[i] === '<'. Returns the index just past the
// closing '>', or -1 when the text at i is not a well-formed tag.
function scanTag(s, i) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') {
    closing = true;
    j++;
  }
  const nm = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s.slice(j));
  if (!nm) return -1;
  j += nm[0].length;
  if (closing) {
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n') j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && s[k + 1] === '>') return k + 2;
    if (k === j) return -1;
    const an = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/.exec(s.slice(k));
    if (!an) return -1;
    k += an[0].length;
    let l = k;
    while (s[l] === ' ' || s[l] === '\t' || s[l] === '\n') l++;
    if (s[l] === '=') {
      l++;
      while (s[l] === ' ' || s[l] === '\t' || s[l] === '\n') l++;
      if (s[l] === '"' || s[l] === "'") {
        const e = s.indexOf(s[l], l + 1);
        if (e < 0) return -1;
        k = e + 1;
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(s.slice(l));
        if (!vm) return -1;
        k = l + vm[0].length;
      }
    }
    j = k;
  }
}

// Scan any inline HTML construct at s[i] === '<' (comment, processing
// instruction, declaration, CDATA, or a tag). End index or -1.
function scanInlineHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    // Abruptly closed comments are complete on their own.
    if (s[i + 4] === '>') return i + 5;
    if (s[i + 4] === '-' && s[i + 5] === '>') return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e < 0 ? -1 : e + 3;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e < 0 ? -1 : e + 3;
  }
  if (/^<![a-zA-Z]/.test(s.slice(i, i + 3))) {
    const e = s.indexOf('>', i + 2);
    return e < 0 ? -1 : e + 1;
  }
  return scanTag(s, i);
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  // Unicode full case folding: ß folds to "ss" (so [ẞ] matches [SS]) and
  // the Latin ligatures fold to their letter expansions.
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st');
}

// Try to read a link reference definition starting at lines[i]. Definitions
// are registered into state.defs (the first one for a label wins) and produce
// no output. Returns { next } when a definition was consumed, { next, para }
// when the definition fell back to destination-only and the rest of the text
// starts a paragraph, or null when lines[i] does not begin a definition.
function tryDef(lines, i, state) {
  const first = lines[i].s;
  const lc = leadCols(first);
  if (lc.cols > 3 || first[lc.idx] !== '[') return null;

  // Work on a window of lines; a definition is short, but a title may
  // span several lines, so allow a generous window.
  const win = [];
  for (let k = i; k < lines.length && win.length < 10; k++) win.push(lines[k].s);
  const str = win.join('\n');
  let pos = lc.idx;

  // Label: no unescaped '[' inside; may span lines but never a blank line.
  let j = pos + 1;
  let labelEnd = -1;
  while (j < str.length) {
    const ch = str[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '[') return null;
    if (ch === ']') {
      labelEnd = j;
      break;
    }
    if (ch === '\n') {
      const nl = str.indexOf('\n', j + 1);
      const nextLine = nl < 0 ? str.slice(j + 1) : str.slice(j + 1, nl);
      if (nextLine.trim() === '') return null;
    }
    j++;
  }
  if (labelEnd < 0) return null;
  const label = str.slice(pos + 1, labelEnd);
  if (!label.trim() || label.length > 999) return null;
  if (str[labelEnd + 1] !== ':') return null;
  pos = labelEnd + 2;

  const lineOf = (p) => {
    let n = 0;
    for (let k = 0; k < p && k < str.length; k++) if (str[k] === '\n') n++;
    return n;
  };
  // Skip spaces/tabs and at most one line ending; never cross a blank line.
  const skipWs = () => {
    for (;;) {
      while (str[pos] === ' ' || str[pos] === '\t') pos++;
      if (str[pos] === '\n') {
        // Crossing is allowed only when the next line is not blank and the
        // line after it does not start before a blank gap.
        const rest = str.slice(pos + 1);
        const nl = rest.indexOf('\n');
        const nextLine = nl < 0 ? rest : rest.slice(0, nl);
        if (nextLine.trim() === '') return false;
        pos++;
        continue;
      }
      return true;
    }
  };

  if (!skipWs()) return null;

  // Destination.
  const destStart = pos;
  let href = null;
  if (str[pos] === '<') {
    let k = pos + 1;
    let ok = false;
    while (k < str.length) {
      const ch = str[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '>') {
        ok = true;
        break;
      }
      if (ch === '\n' || ch === '<') break;
      k++;
    }
    if (!ok) return null;
    href = unescapeStr(str.slice(pos + 1, k));
    pos = k + 1;
  } else {
    let k = pos;
    let depth = 0;
    while (k < str.length) {
      const ch = str[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (k === pos) return null;
    href = unescapeStr(str.slice(pos, k));
    pos = k;
  }
  const destLine = lineOf(pos);
  const destEndPos = pos;

  const register = (title) => {
    const key = normalizeLabel(label);
    if (!state.defs.has(key)) state.defs.set(key, { href, title });
  };
  // Destination-only fallback: the definition counts, and whatever text
  // remains on the failure line starts a paragraph instead.
  const fallback = (failPos) => {
    register(null);
    const k = lineOf(failPos);
    const lineStart = str.lastIndexOf('\n', failPos - 1) + 1;
    const rem = win[k].slice(failPos - lineStart).replace(/^[ \t]+/, '');
    if (rem === '') return { next: i + k + 1 };
    return { next: i + k, para: rem, paraLine: i + k };
  };

  // Scan a title starting at p; returns { title, end } or null. A title
  // may span lines but never crosses a blank line.
  const scanTitle = (p) => {
    const q = str[p];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const close = q === '(' ? ')' : q;
    let k = p + 1;
    while (k < str.length) {
      const ch = str[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === close) {
        return { title: unescapeStr(str.slice(p + 1, k)), end: k + 1 };
      }
      if (q === '(' && ch === '(') return null;
      if (ch === '\n') {
        const nl = str.indexOf('\n', k + 1);
        const nextLine = nl < 0 ? str.slice(k + 1) : str.slice(k + 1, nl);
        if (nextLine.trim() === '') return null;
      }
      k++;
    }
    return null;
  };
  // Index just past trailing spaces/tabs when the line ends there, else -1.
  const atLineEnd = (p) => {
    while (str[p] === ' ' || str[p] === '\t') p++;
    return p >= str.length || str[p] === '\n' ? p : -1;
  };

  // What follows the destination on its own line decides validity: a
  // title there must be whitespace-separated and complete, with nothing
  // after it; anything else invalidates the whole definition.
  let p = destEndPos;
  while (str[p] === ' ' || str[p] === '\t') p++;
  if (p < str.length && str[p] !== '\n') {
    if (p === destEndPos) return null;
    const t = scanTitle(p);
    if (!t) return null;
    const e = atLineEnd(t.end);
    if (e < 0) return null;
    register(t.title);
    return { next: i + lineOf(e) + 1 };
  }
  // The destination line ends cleanly. A complete title alone on the
  // next line is adopted; anything else leaves a title-less definition
  // and the next line is parsed as its own content.
  if (p < str.length && str[p] === '\n' && p + 1 < str.length) {
    let q0 = p + 1;
    while (str[q0] === ' ' || str[q0] === '\t') q0++;
    const t = scanTitle(q0);
    if (t) {
      const e = atLineEnd(t.end);
      if (e >= 0) {
        register(t.title);
        return { next: i + lineOf(e) + 1 };
      }
    }
  }
  register(null);
  return { next: i + destLine + 1 };
}

// ---------------------------------------------------------------------------
// GFM tables: row splitting
// ---------------------------------------------------------------------------

// Split a table row into raw cell texts. A pipe does not separate cells when
// it is escaped or inside a code span. After splitting, escaped pipes become
// literal pipes and cells are trimmed.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const s = line;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let closed = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) {
            closed = j + r2;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (closed >= 0) {
        cur += s.slice(i, closed);
        i = closed;
        continue;
      }
      cur += s.slice(i, i + run);
      i += run;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  const trimmed = line.trim();
  if (trimmed.startsWith('|') && cells.length > 0 && cells[0].trim() === '') {
    cells.shift();
  }
  if (trimmed.endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') {
    // The trailing pipe is a separator only when it was not escaped and not
    // inside a code span; the scan above guarantees the empty last cell can
    // only come from a real separator.
    cells.pop();
  }
  return cells.map((c) => c.replace(/\\\|/g, '|').trim());
}

// Validate a header/delimiter pair. Returns { headerCells, aligns } or null.
function tableAligns(headerLine, delimLine) {
  if (delimLine === undefined) return null;
  if (!headerLine.includes('|') && !delimLine.includes('|')) return null;
  const hc = splitRow(headerLine);
  const dc = splitRow(delimLine);
  if (dc.length === 0 || dc.length !== hc.length) return null;
  const aligns = [];
  for (const cell of dc) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return { headerCells: hc, aligns };
}

// ---------------------------------------------------------------------------
// Block-level constructs
// ---------------------------------------------------------------------------

// A fence opening on this line: { ch, len } or null (info string ignored).
function tryFenceStart(s) {
  const lc = leadCols(s);
  if (lc.cols > 3) return null;
  const m = /^(`{3,}|~{3,})/.exec(s.slice(lc.idx));
  if (!m) return null;
  // The info string of a backtick fence may not contain backticks:
  // ```inner backticks``` is paragraph text (a code span), not a fence.
  if (m[1][0] === '`' && s.slice(lc.idx + m[1].length).indexOf('`') >= 0) return null;
  return { ch: m[1][0], len: m[1].length };
}

function isFenceClose(s, fence) {
  const lc = leadCols(s);
  if (lc.cols > 3) return false;
  const m = /^(`{3,}|~{3,})[ \t]*$/.exec(s.slice(lc.idx));
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

function tryFence(lines, i) {
  const s = lines[i].s;
  const lc = leadCols(s);
  if (lc.cols > 3) return null;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(s.slice(lc.idx));
  if (!m) return null;
  const fence = m[1];
  const ch = fence[0];
  const info = m[2].trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  const content = [];
  let j = i + 1;
  let closed = false;
  const fobj = { ch, len: fence.length };
  while (j < lines.length) {
    const ls = lines[j].s;
    if (isFenceClose(ls, fobj)) {
      closed = true;
      break;
    }
    content.push(stripCols(ls, lc.cols));
    j++;
  }
  let text = content.join('\n');
  if (content.length > 0) text += '\n';
  const lang = info === '' ? '' : unescapeStr(info.split(/\s+/)[0]);
  return { node: { type: 'code', lang, text }, next: closed ? j + 1 : j };
}

function tryAtx(s) {
  const lc = leadCols(s);
  if (lc.cols > 3) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(s.slice(lc.idx));
  if (!m) return null;
  let content = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
  content = content.replace(/(^|[ \t])#+$/, '$1').replace(/[ \t]+$/, '');
  if (/^#+$/.test(content)) content = '';
  return { type: 'heading', level: m[1].length, text: content };
}

function isHr(s) {
  const lc = leadCols(s);
  if (lc.cols > 3) return false;
  const rest = s.slice(lc.idx).replace(/[ \t]/g, '');
  return /^([*\-_])\1{2,}$/.test(rest);
}

// Setext underline level for this line, or 0.
function matchSetext(s) {
  const lc = leadCols(s);
  if (lc.cols > 3) return 0;
  const rest = s.slice(lc.idx);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return 0;
}

// If this line opens a block quote, return its content after the marker
// (one optional space removed); otherwise null.
function matchQuote(s) {
  const lc = leadCols(s);
  if (lc.cols > 3 || s[lc.idx] !== '>') return null;
  const rest = s.slice(lc.idx + 1);
  if (rest.startsWith(' ') || rest.startsWith('\t')) {
    return sliceCols(rest, 1, lc.cols + 1);
  }
  return rest;
}

// A list marker on this line: { ordered, bullet, delim, number, contentCol,
// content } or null.
function matchMarker(s) {
  const lc = leadCols(s);
  if (lc.cols > 3) return null;
  const rest = s.slice(lc.idx);
  let markerLen = 0;
  let ordered = false;
  let bullet = '';
  let delim = '';
  let number = 0;
  const bm = /^([*+-])(?=$|[ \t])/.exec(rest);
  if (bm) {
    bullet = bm[1];
    markerLen = 1;
  } else {
    const om = /^([0-9]{1,9})([.)])(?=$|[ \t])/.exec(rest);
    if (!om) return null;
    ordered = true;
    delim = om[2];
    number = parseInt(om[1], 10);
    markerLen = om[1].length + 1;
  }
  const markerEndCol = lc.cols + markerLen;
  const after = rest.slice(markerLen);
  if (/^[ \t]*$/.test(after)) {
    return {
      ordered, bullet, delim, number,
      contentCol: markerEndCol + 1,
      content: '',
    };
  }
  // Columns of whitespace between the marker and the content.
  let cols = markerEndCol;
  let idx = 0;
  while (idx < after.length) {
    const c = after[idx];
    if (c === ' ') {
      cols++;
      idx++;
    } else if (c === '\t') {
      cols += 4 - (cols % 4);
      idx++;
    } else {
      break;
    }
  }
  const spaces = cols - markerEndCol;
  const contentCol = spaces >= 5 ? markerEndCol + 1 : cols;
  return {
    ordered, bullet, delim, number,
    contentCol,
    content: sliceCols(after, contentCol - markerEndCol, markerEndCol),
  };
}

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html ' +
    'iframe legend li link main menu menuitem nav noframes ol optgroup ' +
    'option p param search section summary table tbody td tfoot th thead ' +
    'title tr track ul').split(' ')
);

// Classify an HTML block start on lines[i]: 'term' (ends at a terminator),
// 'blank' (type 6, ends at a blank line), 'blank7' (type 7, ends at a blank
// line and cannot interrupt a paragraph), or null.
function htmlBlockKind(lines, i) {
  const s = lines[i].s;
  const lc = leadCols(s);
  if (lc.cols > 3) return null;
  const rest = s.slice(lc.idx);
  if (!rest.startsWith('<')) return null;
  if (rest.startsWith('<!--')) return 'term';
  if (rest.startsWith('<?')) return 'term';
  if (/^<![A-Z]/.test(rest)) return 'term';
  if (rest.startsWith('<![CDATA[')) return 'term';
  const m1 = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(rest);
  if (m1) return 'term';
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 'blank';
  if (scanTag(rest, 0) === rest.replace(/[ \t]+$/, '').length && scanTag(rest, 0) > 0) {
    return 'blank7';
  }
  return null;
}

function findTermLine(lines, i, term) {
  for (let j = i; j < lines.length; j++) {
    if (lines[j].s.indexOf(term) >= 0) return j;
  }
  return -1;
}

function tryHtmlBlock(lines, i, endOfDoc, state) {
  const kind = htmlBlockKind(lines, i);
  if (!kind) return null;
  const s = lines[i].s;
  const lc = leadCols(s);
  const rest = s.slice(lc.idx);
  if (kind === 'term') {
    let end = -1;
    if (rest.startsWith('<!--')) end = findTermLine(lines, i, '-->');
    else if (rest.startsWith('<?')) end = findTermLine(lines, i, '?>');
    else if (rest.startsWith('<![CDATA[')) end = findTermLine(lines, i, ']]>');
    else if (/^<![A-Z]/.test(rest)) end = findTermLine(lines, i, '>');
    else {
      const tag = /^<(script|pre|style|textarea)/i.exec(rest)[1].toLowerCase();
      const needle = '</' + tag;
      for (let j = i; j < lines.length; j++) {
        if (lines[j].s.toLowerCase().indexOf(needle) >= 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) end = lines.length - 1;
    const text = lines.slice(i, end + 1).map((x) => x.s).join('\n');
    const nxt = lines[end + 1];
    const reachesEnd = !!endOfDoc && end >= lines.length - 1;
    return {
      node: {
        type: 'html',
        text: text + (reachesEnd || (nxt && nxt.s !== '') ? '\n' : ''),
      },
      next: end + 1,
    };
  }
  // Ends at the first blank line (not included). The block's text gains a
  // trailing newline only when the block effectively ends the document
  // (nothing but blank lines follows it) AND the source itself ended with
  // a newline — a document whose last line is unterminated keeps the
  // block unterminated too.
  let j = i;
  while (j < lines.length && !isBlank(lines[j].s)) j++;
  const text = lines.slice(i, j).map((x) => x.s).join('\n');
  let hasMore = false;
  for (let k = j; k < lines.length; k++) {
    if (!isBlank(lines[k].s)) {
      hasMore = true;
      break;
    }
  }
  return {
    node: {
      type: 'html',
      text:
        text +
        (endOfDoc && !hasMore && state && state.srcEndsWithNewline
          ? '\n'
          : ''),
    },
    next: j,
  };
}

// Would an HTML block starting at lines[j] interrupt a paragraph?
function htmlInterrupts(lines, j) {
  const kind = htmlBlockKind(lines, j);
  return kind === 'term' || kind === 'blank';
}

// Does the last block these (already container-stripped) lines form end in
// an open paragraph? Used to decide lazy continuation lines. Heuristic: the
// last non-blank line is plain paragraph text.
function endsInParagraph(lines) {
  for (let k = lines.length - 1; k >= 0; k--) {
    let s = lines[k].s;
    if (isBlank(s)) return false;
    // See through nested blockquote and list markers: a paragraph may
    // be open inside containers at the tail of the line.
    for (;;) {
      const q = matchQuote(s);
      if (q !== null) {
        s = q;
        continue;
      }
      const mk = matchMarker(s);
      if (mk && !isBlank(mk.content)) {
        s = mk.content;
        continue;
      }
      break;
    }
    if (isBlank(s)) return false;
    if (tryFenceStart(s)) return false;
    if (tryAtx(s)) return false;
    if (isHr(s)) return false;
    if (matchMarker(s)) return false;
    if (leadCols(s).cols >= 4) return false;
    return true;
  }
  return false;
}

// A line that itself opens a block can never be a lazy continuation line.
function startsBlockLine(s) {
  if (tryFenceStart(s)) return true;
  if (tryAtx(s)) return true;
  if (isHr(s)) return true;
  if (matchQuote(s) !== null) return true;
  if (matchMarker(s)) return true;
  if (htmlBlockKind([{ s, lz: false }], 0) !== null) return true;
  return false;
}

function lexBlockquote(lines, i, state, endOfDoc) {
  const inner = [];
  let j = i;
  let lazyOk = false;
  let fence = null;
  while (j < lines.length) {
    const L = lines[j];
    const q = L.lz ? null : matchQuote(L.s);
    if (q !== null) {
      inner.push({ s: q, lz: false });
      j++;
      if (fence) {
        if (isFenceClose(q, fence)) fence = null;
      } else {
        fence = tryFenceStart(q);
      }
      lazyOk = fence ? false : endsInParagraph(inner);
      continue;
    }
    if (isBlank(L.s)) break;
    if (lazyOk && !startsBlockLine(L.s)) {
      inner.push({ s: L.s.replace(/^[ \t]+/, ''), lz: true });
      j++;
      continue;
    }
    break;
  }
  return {
    node: {
      type: 'quote',
      blocks: lexBlocks(inner, state, !!endOfDoc && j >= lines.length),
    },
    next: j,
  };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

function lexList(lines, i, state, endOfDoc) {
  const first = matchMarker(lines[i].s);
  const listBaseCols = leadCols(lines[i].s).cols;
  const items = [];
  let j = i;
  let listDone = false;
  let blankBetween = false;
  while (j < lines.length && !listDone) {
    if (isHr(lines[j].s)) break;
    const mk = matchMarker(lines[j].s);
    if (!mk || !sameListType(first, mk)) break;
    const itemBaseCols = leadCols(lines[j].s).cols;
    const itemLines = [{ s: mk.content, lz: false }];
    j++;
    let inFence = tryFenceStart(mk.content);
    let fenceStartIdx = inFence ? 0 : -1;
    let itemDone = false;
    while (j < lines.length && !itemDone) {
      const L = lines[j];
      const ls = L.s;
      if (isBlank(ls)) {
        // An item with no content yet is not held open by a blank line —
        // unless the next non-blank line is another item of this list, in
        // which case only the empty item ends and the list turns loose.
        if (itemLines.every((x) => isBlank(x.s))) {
          let k = j;
          while (k < lines.length && isBlank(lines[k].s)) k++;
          const nm0 = k < lines.length ? matchMarker(lines[k].s) : null;
          if (
            nm0 &&
            sameListType(first, nm0) &&
            leadCols(lines[k].s).cols < mk.contentCol
          ) {
            while (j < k) {
              itemLines.push({ s: '', lz: false });
              j++;
            }
            blankBetween = true;
            itemDone = true;
            if (leadCols(lines[k].s).cols < listBaseCols) listDone = true;
            break;
          }
          itemDone = true;
          listDone = true;
          break;
        }
        // Decide from the next non-blank line.
        let k = j;
        while (k < lines.length && isBlank(lines[k].s)) k++;
        if (k >= lines.length) {
          j = k;
          itemDone = true;
          listDone = true;
          break;
        }
        if (isHr(lines[k].s)) {
          j = k;
          itemDone = true;
          listDone = true;
          break;
        }
        const nm = matchMarker(lines[k].s);
        if (nm && sameListType(first, nm) && leadCols(lines[k].s).cols < mk.contentCol) {
          while (j < k) {
            itemLines.push({ s: '', lz: false });
            j++;
          }
          blankBetween = true;
          itemDone = true;
          if (leadCols(lines[k].s).cols < listBaseCols) listDone = true;
          break;
        }
        if (inFence || leadCols(lines[k].s).cols >= mk.contentCol) {
          // Inside a fence in an item, a blank run that runs straight
          // into the fence close loses one blank line (cm-318).
          const runLen = k - j;
          const keep =
            inFence && k < lines.length && isFenceClose(lines[k].s, inFence)
              ? runLen - 1
              : runLen;
          for (let n = 0; n < runLen; n++) {
            if (n < keep) itemLines.push({ s: '', lz: false });
            j++;
          }
          continue;
        }
        // The item and the list end here; the blank lines are left
        // unconsumed so the enclosing level can see the separation.
        itemDone = true;
        listDone = true;
        break;
      }
      if (inFence) {
        const sliced =
          leadCols(ls).cols >= mk.contentCol ? sliceCols(ls, mk.contentCol) : ls;
        // A fence that has received no content lines yet does not hold
        // the item open against a line dedented to the item's own level:
        // the item ends and the fence stays unclosed (empty).
        if (
          fenceStartIdx >= 0 &&
          itemLines.length - 1 <= fenceStartIdx &&
          !isFenceClose(sliced, inFence) &&
          leadCols(ls).cols <= itemBaseCols
        ) {
          itemDone = true;
          break;
        }
        itemLines.push({ s: sliced, lz: false });
        // The close is tested in item-relative coordinates: a fence
        // nested deeper in the item has its close indented past the
        // 3-column limit in raw coordinates, which used to leave the
        // fence "open" here and swallow the item's following lines.
        if (isFenceClose(sliced, inFence)) {
          inFence = null;
          fenceStartIdx = -1;
        }
        j++;
        continue;
      }
      const lc = leadCols(ls).cols;
      if (
        lc >= mk.contentCol ||
        (lc >= 2 && endsInParagraph(itemLines) && !startsBlockLine(ls))
      ) {
        // A marker line that does not reach the item's content column
        // can neither continue this list nor start a nested one; with
        // a paragraph open it is paragraph text (cm-312: `- e` at
        // column 4 under an item whose content column is 5).
        if (lc < mk.contentCol && lc >= 2) {
          const stripped = ls.replace(/^[ \t]+/, '');
          if (matchMarker(stripped)) {
            itemLines.push({ s: stripped, lz: true });
            j++;
            continue;
          }
        }
        const sliced = sliceCols(ls, mk.contentCol);
        itemLines.push({ s: sliced, lz: false });
        const f = tryFenceStart(sliced);
        if (f) {
          inFence = f;
          fenceStartIdx = itemLines.length - 1;
        }
        j++;
        continue;
      }
      const nm = matchMarker(ls);
      if (nm && sameListType(first, nm)) {
        itemDone = true;
        // A same-type marker dedented below this list's own base
        // indent belongs to an ancestor list: this list ends too.
        if (leadCols(ls).cols < listBaseCols) listDone = true;
        break;
      }
      if (tryFenceStart(ls)) {
        itemLines.push({ s: ls, lz: false });
        inFence = tryFenceStart(ls);
        // Opened from a line dedented below the content column: not
        // item content, so the unfed-fence rule must not fire for it.
        fenceStartIdx = -1;
        j++;
        continue;
      }
      if (endsInParagraph(itemLines) && !startsBlockLine(ls)) {
        itemLines.push({ s: ls.replace(/^[ \t]+/, ''), lz: true });
        j++;
        continue;
      }
      itemDone = true;
      listDone = true;
    }
    items.push(itemLines);
  }

  // Loose when some item's own blocks are separated by a blank line at
  // the item's own level (tracked by the block lexer via `sep`).
  let loose = false;
  const itemObjs = items.map((itemLines, idx) => {
    const sep = { separated: false };
    const blocks = lexBlocks(
      itemLines,
      state,
      !!endOfDoc && j >= lines.length && idx === items.length - 1,
      sep
    );
    if (sep.separated || blankBetween) loose = true;
    let task = false;
    let checked = false;
    if (blocks.length > 0 && blocks[0].type === 'paragraph') {
      const m = /^\[([ xX])\] /.exec(blocks[0].text);
      if (m) {
        task = true;
        checked = m[1] !== ' ';
        blocks[0].text = blocks[0].text.slice(4);
      }
    }
    return { blocks, task, checked };
  });

  return {
    node: {
      type: 'list',
      ordered: first.ordered,
      start: first.ordered ? first.number : 1,
      loose,
      items: itemObjs,
    },
    next: j,
  };
}

function countItemsAhead(lines, j, mk) {
  const baseCols = leadCols(lines[j].s).cols;
  for (let k = j + 1; k < lines.length; k++) {
    // Blank lines and indented item content do not end the scan: an
    // item may itself contain blank-separated blocks before the next
    // item of the same list appears (doc-10's `0)` list).
    if (isBlank(lines[k].s)) continue;
    const cols = leadCols(lines[k].s).cols;
    const m2 = matchMarker(lines[k].s);
    if (m2 && m2.ordered && m2.delim === mk.delim && cols === baseCols) {
      return 2;
    }
    if (cols <= baseCols) return 1;
  }
  return 1;
}

// Would the block starting at lines[j] interrupt a paragraph?
function interruptsParagraph(lines, j, state) {
  void state;
  const s = lines[j].s;
  if (tryFenceStart(s)) return true;
  if (tryAtx(s)) return true;
  if (isHr(s)) return true;
  if (matchQuote(s) !== null) return true;
  const mk = matchMarker(s);
  if (mk) {
    if (isBlank(mk.content)) return false;
    if (!mk.ordered) return true;
    if (mk.number === 1) return true;
    return countItemsAhead(lines, j, mk) >= 2;
  }
  if (htmlInterrupts(lines, j)) return true;
  if (j + 1 < lines.length && tableAligns(s, lines[j + 1].s)) return true;
  return false;
}

// Setext heading text assembly: each line loses up to three leading
// columns and the final line is right-trimmed. (Paragraph text, by
// contrast, is assembled verbatim.)
function headingText(buf) {
  const parts = buf.map((x, idx) => {
    let s = x.s;
    const lc = leadCols(s).cols;
    if (lc > 0) s = sliceCols(s, Math.min(3, lc));
    if (idx === buf.length - 1) s = s.replace(/[ \t]+$/, '');
    return s;
  });
  return parts.join('\n');
}

function collectParagraph(lines, i, state) {
  const buf = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const L = lines[j];
    if (isBlank(L.s)) {
      // A whitespace-only final line still belongs to the paragraph.
      if (L.s.length > 0 && j === lines.length - 1) {
        buf.push(L);
        j++;
      }
      break;
    }
    if (L.lz) {
      buf.push(L);
      j++;
      continue;
    }
    const su = matchSetext(L.s);
    if (su) {
      return { node: { type: 'heading', level: su, text: headingText(buf) }, next: j + 1 };
    }
    if (interruptsParagraph(lines, j, state)) break;
    buf.push(L);
    j++;
  }
  const text = buf.map((x) => x.s).join('\n');
  return { node: { type: 'paragraph', text }, next: j };
}

function lexIndentedCode(lines, i) {
  const buf = [];
  let j = i;
  while (j < lines.length) {
    const ls = lines[j].s;
    if (isBlank(ls)) {
      let k = j;
      while (k < lines.length && isBlank(lines[k].s)) k++;
      if (k < lines.length && leadCols(lines[k].s).cols >= 4) {
        while (j < k) {
          buf.push(
            leadCols(lines[j].s).cols >= 4 ? sliceCols(lines[j].s, 4) : ''
          );
          j++;
        }
        continue;
      }
      break;
    }
    if (leadCols(ls).cols >= 4) {
      buf.push(sliceCols(ls, 4));
      j++;
      continue;
    }
    break;
  }
  return { node: { type: 'code', lang: '', text: buf.join('\n') + '\n' }, next: j };
}

function tryTable(lines, i, state) {
  void state;
  if (i + 1 >= lines.length) return null;
  const ta = tableAligns(lines[i].s, lines[i + 1].s);
  if (!ta) return null;
  const rows = [];
  let j = i + 2;
  while (
    j < lines.length &&
    !isBlank(lines[j].s) &&
    matchQuote(lines[j].s) === null &&
    !tryFenceStart(lines[j].s) &&
    !tryAtx(lines[j].s) &&
    !isHr(lines[j].s) &&
    htmlBlockKind(lines, j) === null
  ) {
    const cells = splitRow(lines[j].s);
    while (cells.length < ta.headerCells.length) cells.push('');
    rows.push(cells.slice(0, ta.headerCells.length));
    j++;
  }
  return {
    node: { type: 'table', header: ta.headerCells, aligns: ta.aligns, rows },
    next: j,
  };
}

// Lex a list of container-stripped lines into block nodes, registering every
// link reference definition (including nested ones) into state.defs.
function lexBlocks(lines, state, endOfDoc, sep) {
  const blocks = [];
  let i = 0;
  let pendingBlank = false;
  const push = (node) => {
    if (sep && pendingBlank && blocks.length > 0) sep.separated = true;
    pendingBlank = false;
    blocks.push(node);
  };
  while (i < lines.length) {
    const L = lines[i];
    if (isBlank(L.s)) {
      if (blocks.length > 0) pendingBlank = true;
      i++;
      continue;
    }
    if (L.lz) {
      const r = collectParagraph(lines, i, state);
      push(r.node);
      i = r.next;
      continue;
    }
    let r;
    if ((r = tryFence(lines, i))) {
      push(r.node);
      i = r.next;
      continue;
    }
    if ((r = tryAtx(L.s))) {
      push(r);
      i++;
      continue;
    }
    if (isHr(L.s)) {
      push({ type: 'hr' });
      i++;
      continue;
    }
    if (matchQuote(L.s) !== null) {
      r = lexBlockquote(lines, i, state, endOfDoc);
      push(r.node);
      i = r.next;
      continue;
    }
    if (matchMarker(L.s)) {
      r = lexList(lines, i, state, endOfDoc);
      push(r.node);
      i = r.next;
      continue;
    }
    if ((r = tryHtmlBlock(lines, i, endOfDoc, state))) {
      push(r.node);
      i = r.next;
      continue;
    }
    if ((r = tryDef(lines, i, state))) {
      // A definition-only paragraph is still a block element: a blank line
      // before it separates it from the previous block (list looseness).
      if (sep && pendingBlank && blocks.length > 0) sep.separated = true;
      pendingBlank = false;
      if (r.para !== undefined) {
        const sub = [{ s: r.para, lz: false }];
        for (let k = r.paraLine + 1; k < lines.length; k++) sub.push(lines[k]);
        const pr = collectParagraph(sub, 0, state);
        push(pr.node);
        i = r.paraLine + pr.next;
        continue;
      }
      i = r.next;
      continue;
    }
    if ((r = tryTable(lines, i, state))) {
      push(r.node);
      i = r.next;
      continue;
    }
    if (leadCols(L.s).cols >= 4) {
      r = lexIndentedCode(lines, i);
      push(r.node);
      i = r.next;
      continue;
    }
    r = collectParagraph(lines, i, state);
    push(r.node);
    i = r.next;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Parse "(destination "title")" starting just after the '('. Returns
// { href, title, end } where end is just past the closing ')', or null.
function parseLinkTarget(text, i) {
  const n = text.length;
  let j = i;
  const skipWs = () => {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  };
  skipWs();
  let href = '';
  if (text[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '>') {
        ok = true;
        break;
      }
      if (ch === '\n' || ch === '<') break;
      k++;
    }
    if (!ok) return null;
    href = unescapeStr(text.slice(j + 1, k));
    j = k + 1;
  } else {
    // Bare destination: scanned with paren balancing even when it starts
    // with a quote or paren — ("title") is a destination, not a title.
    let k = j;
    let depth = 0;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    href = unescapeStr(text.slice(j, k));
    j = k;
  }
  skipWs();
  let title = null;
  const q = text[j];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === close) {
        ok = true;
        break;
      }
      if (q === '(' && ch === '(') break;
      k++;
    }
    if (!ok) return null;
    title = unescapeStr(text.slice(j + 1, k));
    j = k + 1;
    skipWs();
  }
  if (text[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// The HTML5 named character references (without & and ;), for deciding
// whether a trailing entity-shaped suffix of an autolink is real.
const ENTITY_NAMES = new Set(
  ('AElig AMP Aacute Abreve Acirc Acy Afr Agrave Alpha Amacr And Aogon Aopf ApplyFunction Aring Ascr Assign Atilde Auml Backslash Barv Barwed Bcy Because Bernoullis Beta Bfr Bopf Breve Bscr Bumpeq CHcy COPY Cacute Cap CapitalDifferentialD Cayleys Ccaron Ccedil Ccirc Cconint Cdot Cedilla CenterDot Cfr Chi CircleDot CircleMinus CirclePlus CircleTimes ClockwiseContourIntegral CloseCurlyDoubleQuote CloseCurlyQuote Colon Colone Congruent Conint ContourIntegral Copf Coproduct CounterClockwiseContourIntegral Cross Cscr Cup CupCap DD DDotrahd DJcy DScy DZcy Dagger Darr Dashv Dcaron Dcy Del Delta Dfr DiacriticalAcute DiacriticalDot DiacriticalDoubleAcute DiacriticalGrave DiacriticalTilde Diamond DifferentialD Dopf Dot DotDot DotEqual DoubleContourIntegral DoubleDot DoubleDownArrow DoubleLeftArrow DoubleLeftRightArrow DoubleLeftTee DoubleLongLeftArrow DoubleLongLeftRightArrow DoubleLongRightArrow DoubleRightArrow DoubleRightTee DoubleUpArrow DoubleUpDownArrow DoubleVerticalBar DownArrow DownArrowBar DownArrowUpArrow DownBreve DownLeftRightVector DownLeftTeeVector DownLeftVector DownLeftVectorBar DownRightTeeVector DownRightVector DownRightVectorBar DownTee DownTeeArrow Downarrow Dscr Dstrok ENG ETH Eacute Ecaron Ecirc Ecy Edot Efr Egrave Element Emacr EmptySmallSquare EmptyVerySmallSquare Eogon Eopf Epsilon Equal EqualTilde Equilibrium Escr Esim Eta Euml Exists ExponentialE Fcy Ffr FilledSmallSquare FilledVerySmallSquare Fopf ForAll Fouriertrf Fscr GJcy GT Gamma Gammad Gbreve Gcedil Gcirc Gcy Gdot Gfr Gg Gopf GreaterEqual GreaterEqualLess GreaterFullEqual GreaterGreater GreaterLess GreaterSlantEqual GreaterTilde Gscr Gt HARDcy Hacek Hat Hcirc Hfr HilbertSpace Hopf HorizontalLine Hscr Hstrok HumpDownHump HumpEqual IEcy IJlig IOcy Iacute Icirc Icy Idot Ifr Igrave Im Imacr ImaginaryI Implies Int Integral Intersection InvisibleComma InvisibleTimes Iogon Iopf Iota Iscr Itilde Iukcy Iuml Jcirc Jcy Jfr Jopf Jscr Jsercy Jukcy KHcy KJcy Kappa Kcedil Kcy Kfr Kopf Kscr LJcy LT Lacute Lambda Lang Laplacetrf Larr Lcaron Lcedil Lcy LeftAngleBracket LeftArrow LeftArrowBar LeftArrowRightArrow LeftCeiling LeftDoubleBracket LeftDownTeeVector LeftDownVector LeftDownVectorBar LeftFloor LeftRightArrow LeftRightVector LeftTee LeftTeeArrow LeftTeeVector LeftTriangle LeftTriangleBar LeftTriangleEqual LeftUpDownVector LeftUpTeeVector LeftUpVector LeftUpVectorBar LeftVector LeftVectorBar Leftarrow Leftrightarrow LessEqualGreater LessFullEqual LessGreater LessLess LessSlantEqual LessTilde Lfr Ll Lleftarrow Lmidot LongLeftArrow LongLeftRightArrow LongRightArrow Longleftarrow Longleftrightarrow Longrightarrow Lopf LowerLeftArrow LowerRightArrow Lscr Lsh Lstrok Lt Map Mcy MediumSpace Mellintrf Mfr MinusPlus Mopf Mscr Mu NJcy Nacute Ncaron Ncedil Ncy NegativeMediumSpace NegativeThickSpace NegativeThinSpace NegativeVeryThinSpace NestedGreaterGreater NestedLessLess NewLine Nfr NoBreak NonBreakingSpace Nopf Not NotCongruent NotCupCap NotDoubleVerticalBar NotElement NotEqual NotEqualTilde NotExists NotGreater NotGreaterEqual NotGreaterFullEqual NotGreaterGreater NotGreaterLess NotGreaterSlantEqual NotGreaterTilde NotHumpDownHump NotHumpEqual NotLeftTriangle NotLeftTriangleBar NotLeftTriangleEqual NotLess NotLessEqual NotLessGreater NotLessLess NotLessSlantEqual NotLessTilde NotNestedGreaterGreater NotNestedLessLess NotPrecedes NotPrecedesEqual NotPrecedesSlantEqual NotReverseElement NotRightTriangle NotRightTriangleBar NotRightTriangleEqual NotSquareSubset NotSquareSubsetEqual NotSquareSuperset NotSquareSupersetEqual NotSubset NotSubsetEqual NotSucceeds NotSucceedsEqual NotSucceedsSlantEqual NotSucceedsTilde NotSuperset NotSupersetEqual NotTilde NotTildeEqual NotTildeFullEqual NotTildeTilde NotVerticalBar Nscr Ntilde Nu OElig Oacute Ocirc Ocy Odblac Ofr Ograve Omacr Omega Omicron Oopf OpenCurlyDoubleQuote OpenCurlyQuote Or Oscr Oslash Otilde Otimes Ouml OverBar OverBrace OverBracket OverParenthesis PartialD Pcy Pfr Phi Pi PlusMinus Poincareplane Popf Pr Precedes PrecedesEqual PrecedesSlantEqual PrecedesTilde Prime Product Proportion Proportional Pscr Psi QUOT Qfr Qopf Qscr RBarr REG Racute Rang Rarr Rarrtl Rcaron Rcedil Rcy Re ReverseElement ReverseEquilibrium ReverseUpEquilibrium Rfr Rho RightAngleBracket RightArrow RightArrowBar RightArrowLeftArrow RightCeiling RightDoubleBracket RightDownTeeVector RightDownVector RightDownVectorBar RightFloor RightTee RightTeeArrow RightTeeVector RightTriangle RightTriangleBar RightTriangleEqual RightUpDownVector RightUpTeeVector RightUpVector RightUpVectorBar RightVector RightVectorBar Rightarrow Ropf RoundImplies Rrightarrow Rscr Rsh RuleDelayed SHCHcy SHcy SOFTcy Sacute Sc Scaron Scedil Scirc Scy Sfr ShortDownArrow ShortLeftArrow ShortRightArrow ShortUpArrow Sigma SmallCircle Sopf Sqrt Square SquareIntersection SquareSubset SquareSubsetEqual SquareSuperset SquareSupersetEqual SquareUnion Sscr Star Sub Subset SubsetEqual Succeeds SucceedsEqual SucceedsSlantEqual SucceedsTilde SuchThat Sum Sup Superset SupersetEqual Supset THORN TRADE TSHcy TScy Tab Tau Tcaron Tcedil Tcy Tfr Therefore Theta ThickSpace ThinSpace Tilde TildeEqual TildeFullEqual TildeTilde Topf TripleDot Tscr Tstrok Uacute Uarr Uarrocir Ubrcy Ubreve Ucirc Ucy Udblac Ufr Ugrave Umacr UnderBar UnderBrace UnderBracket UnderParenthesis Union UnionPlus Uogon Uopf UpArrow UpArrowBar UpArrowDownArrow UpDownArrow UpEquilibrium UpTee UpTeeArrow Uparrow Updownarrow UpperLeftArrow UpperRightArrow Upsi Upsilon Uring Uscr Utilde Uuml VDash Vbar Vcy Vdash Vdashl Vee Verbar Vert VerticalBar VerticalLine VerticalSeparator VerticalTilde VeryThinSpace Vfr Vopf Vscr Vvdash Wcirc Wedge Wfr Wopf Wscr Xfr Xi Xopf Xscr YAcy YIcy YUcy Yacute Ycirc Ycy Yfr Yopf Yscr Yuml ZHcy Zacute Zcaron Zcy Zdot ZeroWidthSpace Zeta Zfr Zopf Zscr ' +
   'aacute abreve ac acE acd acirc acute acy aelig af afr agrave alefsym aleph alpha amacr amalg amp and andand andd andslope andv ang ange angle angmsd angmsdaa angmsdab angmsdac angmsdad angmsdae angmsdaf angmsdag angmsdah angrt angrtvb angrtvbd angsph angst angzarr aogon aopf ap apE apacir ape apid apos approx approxeq aring ascr ast asymp asympeq atilde auml awconint awint bNot backcong backepsilon backprime backsim backsimeq barvee barwed barwedge bbrk bbrktbrk bcong bcy bdquo becaus because bemptyv bepsi bernou beta beth between bfr bigcap bigcirc bigcup bigodot bigoplus bigotimes bigsqcup bigstar bigtriangledown bigtriangleup biguplus bigvee bigwedge bkarow blacklozenge blacksquare blacktriangle blacktriangledown blacktriangleleft blacktriangleright blank blk12 blk14 blk34 block bne bnequiv bnot bopf bot bottom bowtie boxDL boxDR boxDl boxDr boxH boxHD boxHU boxHd boxHu boxUL boxUR boxUl boxUr boxV boxVH boxVL boxVR boxVh boxVl boxVr boxbox boxdL boxdR boxdl boxdr boxh boxhD boxhU boxhd boxhu boxminus boxplus boxtimes boxuL boxuR boxul boxur boxv boxvH boxvL boxvR boxvh boxvl boxvr bprime breve brvbar bscr bsemi bsim bsime bsol bsolb bsolhsub bull bullet bump bumpE bumpe bumpeq cacute cap capand capbrcup capcap capcup capdot caps caret caron ccaps ccaron ccedil ccirc ccups ccupssm cdot cedil cemptyv cent centerdot cfr chcy check checkmark chi cir cirE circ circeq circlearrowleft circlearrowright circledR circledS circledast circledcirc circleddash cire cirfnint cirmid cirscir clubs clubsuit colon colone coloneq comma commat comp compfn complement complexes cong congdot conint copf coprod copy copysr crarr cross cscr csub csube csup csupe ctdot cudarrl cudarrr cuepr cuesc cularr cularrp cup cupbrcap cupcap cupcup cupdot cupor cups curarr curarrm curlyeqprec curlyeqsucc curlyvee curlywedge curren curvearrowleft curvearrowright cuvee cuwed cwconint cwint cylcty dArr dHar dagger daleth darr dash dashv dbkarow dblac dcaron dcy dd ddagger ddarr ddotseq deg delta demptyv dfisht dfr dharl dharr diam diamond diamondsuit diams die digamma disin div divide divideontimes divonx djcy dlcorn dlcrop dollar dopf dot doteq doteqdot dotminus dotplus dotsquare doublebarwedge downarrow downdownarrows downharpoonleft downharpoonright drbkarow drcorn drcrop dscr dscy dsol dstrok dtdot dtri dtrif duarr duhar dwangle dzcy dzigrarr eDDot eDot eacute easter ecaron ecir ecirc ecolon ecy edot ee efDot efr eg egrave egs egsdot el elinters ell els elsdot emacr empty emptyset emptyv emsp emsp13 emsp14 eng ensp eogon eopf epar eparsl eplus epsi epsilon epsiv eqcirc eqcolon eqsim eqslantgtr eqslantless equals equest equiv equivDD eqvparsl erDot erarr escr esdot esim eta eth euml euro excl exist expectation exponentiale fallingdotseq fcy female ffilig fflig ffllig ffr filig fjlig flat fllig fltns fnof fopf forall fork forkv fpartint frac12 frac13 frac14 frac15 frac16 frac18 frac23 frac25 frac34 frac35 frac38 frac45 frac56 frac58 frac78 frasl frown fscr gE gEl gacute gamma gammad gap gbreve gcirc gcy gdot ge gel geq geqq geqslant ges gescc gesdot gesdoto gesdotol gesl gesles gfr gg ggg gimel gjcy gl glE gla glj gnE gnap gnapprox gne gneq gneqq gnsim gopf grave gscr gsim gsime gsiml gt gtcc gtcir gtdot gtlPar gtquest gtrapprox gtrarr gtrdot gtreqless gtreqqless gtrless gtrsim gvertneqq gvnE hArr hairsp half hamilt hardcy harr harrcir harrw hbar hcirc hearts heartsuit hellip hercon hfr hksearow hkswarow hoarr homtht hookleftarrow hookrightarrow hopf horbar hscr hslash hstrok hybull hyphen iacute ic icirc icy iecy iexcl iff ifr igrave ii iiiint iiint iinfin iiota ijlig imacr image imagline imagpart imath imof imped in incare infin infintie inodot int intcal integers intercal intlarhk intprod iocy iogon iopf iota iprod iquest iscr isin isinE isindot isins isinsv isinv it itilde iukcy iuml jcirc jcy jfr jmath jopf jscr jsercy jukcy kappa kappav kcedil kcy kfr kgreen khcy kjcy kopf kscr lAarr lArr lAtail lBarr lE lEg lHar lacute laemptyv lagran lambda lang langd langle lap laquo larr larrb larrbfs larrfs larrhk larrlp larrpl larrsim larrtl lat latail late lates lbarr lbbrk lbrace lbrack lbrke lbrksld lbrkslu lcaron lcedil lceil lcub lcy ldca ldquo ldquor ldrdhar ldrushar ldsh le leftarrow leftarrowtail leftharpoondown leftharpoonup leftleftarrows leftrightarrow leftrightarrows leftrightharpoons leftrightsquigarrow leftthreetimes leg leq leqq leqslant les lescc lesdot lesdoto lesdotor lesg lesges lessapprox lessdot lesseqgtr lesseqqgtr lessgtr lesssim lfisht lfloor lfr lg lgE lhard lharu lharul lhblk ljcy ll llarr llcorner llhard lltri lmidot lmoust lmoustache lnE lnap lnapprox lne lneq lneqq lnsim loang loarr lobrk longleftarrow longleftrightarrow longmapsto longrightarrow looparrowleft looparrowright lopar lopf loplus lotimes lowast lowbar loz lozenge lozf lpar lparlt lrarr lrcorner lrhar lrhard lrm lrtri lsaquo lscr lsh lsim lsime lsimg lsqb lsquo lsquor lstrok lt ltcc ltcir ltdot lthree ltimes ltlarr ltquest ltrPar ltri ltrie ltrif lurdshar luruhar lvertneqq lvnE mDDot macr male malt maltese map mapsto mapstodown mapstoleft mapstoup marker mcomma mcy mdash measuredangle mfr mho micro mid midast midcir middot minus minusb minusd minusdu mlcp mldr mnplus models mopf mp mscr mstpos mu multimap mumap nGg nGt nGtv nLeftarrow nLeftrightarrow nLl nLt nLtv nRightarrow nVDash nVdash nabla nacute nang nap napE napid napos napprox natur natural naturals nbsp nbump nbumpe ncap ncaron ncedil ncong ncongdot ncup ncy ndash ne neArr nearhk nearr nearrow nedot nequiv nesear nesim nexist nexists nfr ngE nge ngeq ngeqq ngeqslant nges ngsim ngt ngtr nhArr nharr nhpar ni nis nisd niv njcy nlArr nlE nlarr nldr nle nleftarrow nleftrightarrow nleq nleqq nleqslant nles nless nlsim nlt nltri nltrie nmid nopf not notin notinE notindot notinva notinvb notinvc notni notniva notnivb notnivc npar nparallel nparsl npart npolint npr nprcue npre nprec npreceq nrArr nrarr nrarrc nrarrw nrightarrow nrtri nrtrie nsc nsccue nsce nscr nshortmid nshortparallel nsim nsime nsimeq nsmid nspar nsqsube nsqsupe nsub nsubE nsube nsubset nsubseteq nsubseteqq nsucc nsucceq nsup nsupE nsupe nsupset nsupseteq nsupseteqq ntgl ntilde ntlg ntriangleleft ntrianglelefteq ntriangleright ntrianglerighteq nu num numero numsp nvDash nvHarr nvap nvdash nvge nvgt nvinfin nvlArr nvle nvlt nvltrie nvrArr nvrtrie nvsim nwArr nwarhk nwarr nwarrow nwnear oS oacute oast ocir ocirc ocy odash odblac odiv odot odsold oelig ofcir ofr ogon ograve ogt ohbar ohm oint olarr olcir olcross oline olt omacr omega omicron omid ominus oopf opar operp oplus or orarr ord order orderof ordf ordm origof oror orslope orv oscr oslash osol otilde otimes otimesas ouml ovbar par para parallel parsim parsl part pcy percnt period permil perp pertenk pfr phi phiv phmmat phone pi pitchfork piv planck planckh plankv plus plusacir plusb pluscir plusdo plusdu pluse plusmn plussim plustwo pm pointint popf pound pr prE prap prcue pre prec precapprox preccurlyeq preceq precnapprox precneqq precnsim precsim prime primes prnE prnap prnsim prod profalar profline profsurf prop propto prsim prurel pscr psi puncsp qfr qint qopf qprime qscr quaternions quatint quest questeq quot rAarr rArr rAtail rBarr rHar race racute radic raemptyv rang rangd range rangle raquo rarr rarrap rarrb rarrbfs rarrc rarrfs rarrhk rarrlp rarrpl rarrsim rarrtl rarrw ratail ratio rationals rbarr rbbrk rbrace rbrack rbrke rbrksld rbrkslu rcaron rcedil rceil rcub rcy rdca rdldhar rdquo rdquor rdsh real realine realpart reals rect reg rfisht rfloor rfr rhard rharu rharul rho rhov rightarrow rightarrowtail rightharpoondown rightharpoonup rightleftarrows rightleftharpoons rightrightarrows rightsquigarrow rightthreetimes ring risingdotseq rlarr rlhar rlm rmoust rmoustache rnmid roang roarr robrk ropar ropf roplus rotimes rpar rpargt rppolint rrarr rsaquo rscr rsh rsqb rsquo rsquor rthree rtimes rtri rtrie rtrif rtriltri ruluhar rx sacute sbquo sc scE scap scaron sccue sce scedil scirc scnE scnap scnsim scpolint scsim scy sdot sdotb sdote seArr searhk searr searrow sect semi seswar setminus setmn sext sfr sfrown sharp shchcy shcy shortmid shortparallel shy sigma sigmaf sigmav sim simdot sime simeq simg simgE siml simlE simne simplus simrarr slarr smallsetminus smashp smeparsl smid smile smt smte smtes softcy sol solb solbar sopf spades spadesuit spar sqcap sqcaps sqcup sqcups sqsub sqsube sqsubset sqsubseteq sqsup sqsupe sqsupset sqsupseteq squ square squarf squf srarr sscr ssetmn ssmile sstarf star starf straightepsilon straightphi strns sub subE subdot sube subedot submult subnE subne subplus subrarr subset subseteq subseteqq subsetneq subsetneqq subsim subsub subsup succ succapprox succcurlyeq succeq succnapprox succneqq succnsim succsim sum sung sup sup1 sup2 sup3 supE supdot supdsub supe supedot suphsol suphsub suplarr supmult supnE supne supplus supset supseteq supseteqq supsetneq supsetneqq supsim supsub supsup swArr swarhk swarr swarrow swnwar szlig target tau tbrk tcaron tcedil tcy tdot telrec tfr there4 therefore theta thetasym thetav thickapprox thicksim thinsp thkap thksim thorn tilde times timesb timesbar timesd tint toea top topbot topcir topf topfork tosa tprime trade triangle triangledown triangleleft trianglelefteq triangleq triangleright trianglerighteq tridot trie triminus triplus trisb tritime trpezium tscr tscy tshcy tstrok twixt twoheadleftarrow twoheadrightarrow uArr uHar uacute uarr ubrcy ubreve ucirc ucy udarr udblac udhar ufisht ufr ugrave uharl uharr uhblk ulcorn ulcorner ulcrop ultri umacr uml uogon uopf uparrow updownarrow upharpoonleft upharpoonright uplus upsi upsih upsilon upuparrows urcorn urcorner urcrop uring urtri uscr utdot utilde utri utrif uuarr uuml uwangle vArr vBar vBarv vDash vangrt varepsilon varkappa varnothing varphi varpi varpropto varr varrho varsigma varsubsetneq varsubsetneqq varsupsetneq varsupsetneqq vartheta vartriangleleft vartriangleright vcy vdash vee veebar veeeq vellip verbar vert vfr vltri vnsub vnsup vopf vprop vrtri vscr vsubnE vsubne vsupnE vsupne vzigzag wcirc wedbar wedge wedgeq weierp wfr wopf wp wr wreath wscr xcap xcirc xcup xdtri xfr xhArr xharr xi xlArr xlarr xmap xnis xodot xopf xoplus xotime xrArr xrarr xscr xsqcup xuplus xutri xvee xwedge yacute yacy ycirc ycy yen yfr yicy yopf yscr yucy yuml zacute zcaron zcy zdot zeetrf zeta zfr zhcy zigrarr zopf zscr zwj zwnj').split(' ')
);

// Trim an extended autolink: trailing punctuation is not part of the link,
// a trailing semicolon survives only as part of a real entity reference (a
// would-be entity that does not exist is excluded whole), and unbalanced
// closing parentheses are shed.
function trimUrl(u) {
  for (;;) {
    if (u === '') break;
    const last = u[u.length - 1];
    if ('?!.,:*_~'.indexOf(last) >= 0) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const amp = u.lastIndexOf('&');
      const em =
        amp >= 0
          ? /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|([a-zA-Z][a-zA-Z0-9]*));$/.exec(
              u.slice(amp)
            )
          : null;
      if (em) {
        if (em[1] === undefined || ENTITY_NAMES.has(em[1])) break;
        u = u.slice(0, amp);
        continue;
      }
      u = u.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let open = 0;
      let close = 0;
      for (const ch of u) {
        if (ch === '(') open++;
        else if (ch === ')') close++;
      }
      if (close > open) {
        u = u.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return u;
}

const EMAIL_SRC =
  '[a-zA-Z0-9.!#$%&\'*+\\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?' +
  '(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+';
const EMAIL_RE = new RegExp('^' + EMAIL_SRC);
const EMAIL_ANGLE_RE = new RegExp('^<(' + EMAIL_SRC + ')>');

function matchWww(text, i) {
  if (!text.startsWith('www.', i)) return null;
  const m = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/.exec(text.slice(i + 4));
  if (!m) return null;
  const tail = /^[^\s<`\\]*/.exec(text.slice(i + 4 + m[0].length))[0];
  const full = trimUrl('www.' + m[0] + tail);
  if (full.length <= 4) return null;
  return { url: full, end: i + full.length, email: false };
}

function matchScheme(text, i) {
  const m = /^(?:https?|ftp):\/\//i.exec(text.slice(i));
  if (!m) return null;
  const tail = /^[^\s<`\\]*/.exec(text.slice(i + m[0].length))[0];
  if (!tail) return null;
  const full = trimUrl(m[0] + tail);
  if (full.length <= m[0].length) return null;
  return { url: full, end: i + full.length, email: false };
}

function matchEmail(text, i) {
  const m = EMAIL_RE.exec(text.slice(i));
  if (!m) return null;
  // An address immediately followed by - or _ is not a link at all: the
  // character would belong to the address but cannot end it.
  const nx = text[i + m[0].length];
  if (nx === '-' || nx === '_') return null;
  return { url: m[0], end: i + m[0].length, email: true };
}

// GFM: mailto: and xmpp: scheme-prefixed email autolinks. The whole
// scheme + address forms one link; xmpp may carry one /resource segment.
function matchMailtoXmpp(text, i) {
  const sm = /^(mailto|xmpp):/i.exec(text.slice(i));
  if (!sm) return null;
  const rest = i + sm[0].length;
  const em = EMAIL_RE.exec(text.slice(rest));
  if (!em) return null;
  let end = rest + em[0].length;
  const nx = text[end];
  if (nx === '-' || nx === '_') return null;
  if (sm[1].toLowerCase() === 'xmpp' && text[end] === '/') {
    const rm = /^\/[^\s<>/]+/.exec(text.slice(end));
    if (rm) end += rm[0].length;
  }
  return { url: text.slice(i, end), end, email: false };
}

// The plain-text content of a node list (used for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text':
      case 'raw':
      case 'code':
        out += nd.s;
        break;
      case 'delim':
        out += nd.ch.repeat(nd.len);
        break;
      case 'open':
        out += nd.img ? '![' : '[';
        break;
      case 'br':
        out += '\n';
        break;
      case 'em':
      case 'strong':
      case 'del':
      case 'link':
      case 'img':
        out += plainText(nd.kids);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text':
        out += escText(nd.s);
        break;
      case 'raw':
        out += nd.s;
        break;
      case 'code':
        out += '<code>' + escText(nd.s) + '</code>';
        break;
      case 'html':
        out += nd.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
        out += nd.ch.repeat(nd.len);
        break;
      case 'open':
        out += nd.img ? '![' : '[';
        break;
      case 'em':
        out += '<em>' + renderNodes(nd.kids) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderNodes(nd.kids) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderNodes(nd.kids) + '</del>';
        break;
      case 'link':
        out +=
          '<a href="' +
          escAttr(cleanUrl(nd.href)) +
          '"' +
          (nd.title !== null && nd.title !== undefined
            ? ' title="' + escAttr(nd.title) + '"'
            : '') +
          '>' +
          renderNodes(nd.kids) +
          '</a>';
        break;
      case 'img':
        out +=
          '<img src="' +
          escAttr(cleanUrl(nd.href)) +
          '" alt="' +
          escAttr(plainText(nd.kids)) +
          '"' +
          (nd.title !== null && nd.title !== undefined
            ? ' title="' + escAttr(nd.title) + '"'
            : '') +
          '>';
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(text, state) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const n = text.length;
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf !== '') {
      nodes.push({ k: 'text', s: buf });
      buf = '';
    }
  };

  // The CommonMark emphasis matching algorithm over the delimiter stack,
  // restricted to entries at index >= bottom.
  function processEmphasis(bottom) {
    let closerIdx = bottom;
    while (closerIdx < delims.length) {
      const closer = delims[closerIdx];
      if (!closer.canClose || closer.node.len === 0) {
        closerIdx++;
        continue;
      }
      let openerIdx = -1;
      for (let k = closerIdx - 1; k >= bottom; k--) {
        const op = delims[k];
        if (op.ch !== closer.ch || !op.canOpen || op.node.len === 0) continue;
        if (op.canClose || closer.canOpen) {
          const sum = op.origLen + closer.origLen;
          if (sum % 3 === 0 && !(op.origLen % 3 === 0 && closer.origLen % 3 === 0)) {
            continue;
          }
        }
        openerIdx = k;
        break;
      }
      if (openerIdx < 0) {
        closerIdx++;
        continue;
      }
      const op = delims[openerIdx];
      let use;
      if (op.ch === '~') use = op.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
      else use = op.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
      if (op.node.len < use || closer.node.len < use) {
        closerIdx++;
        continue;
      }
      op.node.len -= use;
      closer.node.len -= use;
      const kind = op.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const ai = nodes.indexOf(op.node);
      const bi = nodes.indexOf(closer.node);
      const inner = nodes.splice(ai + 1, bi - ai - 1);
      nodes.splice(ai + 1, 0, { k: kind, kids: inner });
      delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
      closerIdx = openerIdx + 1;
      if (closer.node.len === 0) delims.splice(closerIdx, 1);
      if (op.node.len === 0) {
        delims.splice(openerIdx, 1);
        closerIdx--;
      }
    }
  }

  // Attempt to form a link or image at the ']' at position pos. Returns the
  // index just past the link syntax, or -1.
  function tryCloseBracket(pos) {
    if (brackets.length === 0) return -1;
    const br = brackets[brackets.length - 1];
    if (!br.active) {
      brackets.pop();
      return -1;
    }
    const contentRaw = text.slice(br.contentStart, pos);
    let href = null;
    let title = null;
    let end = -1;
    const after = pos + 1;
    if (text[after] === '(') {
      const t = parseLinkTarget(text, after + 1);
      if (t) {
        href = t.href;
        title = t.title;
        end = t.end;
      }
    }
    let sawRefLabel = false;
    if (end < 0 && text[after] === '[') {
      let k = after + 1;
      let refEnd = -1;
      while (k < n) {
        const ch = text[k];
        if (ch === '\\') {
          k += 2;
          continue;
        }
        if (ch === '[') break;
        if (ch === ']') {
          refEnd = k;
          break;
        }
        k++;
      }
      if (refEnd >= 0) {
        // A complete second label was present: if it does not resolve, the
        // whole link fails — there is no shortcut-reference fallback.
        sawRefLabel = true;
        const refRaw = text.slice(after + 1, refEnd);
        const label = refRaw === '' ? contentRaw : refRaw;
        const def = state.defs.get(normalizeLabel(label));
        if (def) {
          href = def.href;
          title = def.title;
          end = refEnd + 1;
        }
      }
    }
    if (end < 0 && !sawRefLabel) {
      const def = state.defs.get(normalizeLabel(contentRaw));
      if (def) {
        href = def.href;
        title = def.title;
        end = pos + 1;
      }
    }
    if (end < 0) {
      brackets.pop();
      return -1;
    }
    processEmphasis(br.delimIdx);
    const ai = nodes.indexOf(br.node);
    const kids = nodes.splice(ai + 1, nodes.length - ai - 1);
    nodes.splice(ai, 1);
    delims.length = br.delimIdx;
    brackets.pop();
    if (br.img) {
      nodes.push({ k: 'img', href, title, kids });
    } else {
      nodes.push({ k: 'link', href, title, kids });
      for (const b of brackets) if (!b.img) b.active = false;
    }
    return end;
  }

  const atBoundary = () => {
    if (i === 0) return true;
    const p = text[i - 1];
    return !/[a-zA-Z0-9_\-.@/]/.test(p);
  };

  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        // Leading whitespace of the next line is not significant.
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.indexOf(nx) >= 0) {
        buf += nx;
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let j = i + run;
      let closeStart = -1;
      let closeEnd = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 1;
          while (text[j + r2] === '`') r2++;
          if (r2 === run) {
            closeStart = j;
            closeEnd = j + r2;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (closeStart < 0) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      let content = text.slice(i + run, closeStart).replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content.startsWith(' ') &&
        content.endsWith(' ') &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = closeEnd;
      continue;
    }

    if (c === '&') {
      const rest = text.slice(i);
      const nm = /^&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/.exec(rest);
      if (nm) {
        buf += decodeCodePoint(
          nm[1] !== undefined ? parseInt(nm[1], 16) : parseInt(nm[2], 10)
        );
        i += nm[0].length;
        continue;
      }
      const em = /^&[a-zA-Z][a-zA-Z0-9]*;/.exec(rest);
      if (em) {
        flush();
        nodes.push({ k: 'raw', s: em[0] });
        i += em[0].length;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }

    if (c === '<') {
      const rest = text.slice(i);
      const am = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
      if (am) {
        flush();
        nodes.push({
          k: 'link',
          href: am[1],
          title: null,
          kids: [{ k: 'text', s: am[1] }],
        });
        i += am[0].length;
        continue;
      }
      const em2 = EMAIL_ANGLE_RE.exec(rest);
      if (em2) {
        flush();
        nodes.push({
          k: 'link',
          href: 'mailto:' + em2[1],
          title: null,
          kids: [{ k: 'text', s: em2[1] }],
        });
        i += em2[0].length;
        continue;
      }
      const he = scanInlineHtml(text, i);
      if (he > 0) {
        flush();
        nodes.push({ k: 'html', s: text.slice(i, he) });
        i = he;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }

    if (c === '!' && text[i + 1] === '[') {
      flush();
      const nd = { k: 'open', img: true };
      nodes.push(nd);
      brackets.push({
        node: nd,
        img: true,
        active: true,
        contentStart: i + 2,
        delimIdx: delims.length,
      });
      i += 2;
      continue;
    }

    if (c === '[') {
      flush();
      const nd = { k: 'open', img: false };
      nodes.push(nd);
      brackets.push({
        node: nd,
        img: false,
        active: true,
        contentStart: i + 1,
        delimIdx: delims.length,
      });
      i++;
      continue;
    }

    if (c === ']') {
      flush();
      const end = tryCloseBracket(i);
      if (end > 0) {
        i = end;
        continue;
      }
      buf += ']';
      i++;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (text[i + run] === c) run++;
      if (c === '~' && run > 2) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      const prev = i === 0 ? undefined : text[i - 1];
      const next = i + run >= n ? undefined : text[i + run];
      let canOpen;
      let canClose;
      if (c === '~') {
        canOpen = !isSpaceChar(next);
        canClose = !isSpaceChar(prev);
      } else {
        const lf =
          !isSpaceChar(next) &&
          (!isPunctChar(next) || isSpaceChar(prev) || isPunctChar(prev));
        const rf =
          !isSpaceChar(prev) &&
          (!isPunctChar(prev) || isSpaceChar(next) || isPunctChar(next));
        if (c === '*') {
          canOpen = lf;
          canClose = rf;
        } else {
          canOpen = lf && (!rf || isPunctChar(prev));
          canClose = rf && (!lf || isPunctChar(next));
        }
      }
      flush();
      const nd = { k: 'delim', ch: c, len: run, origLen: run };
      nodes.push(nd);
      delims.push({ node: nd, ch: c, origLen: run, canOpen, canClose });
      i += run;
      continue;
    }

    if (c === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        nodes.push({ k: 'br' });
        i++;
        // Leading whitespace of the next line is not significant.
        while (text[i] === ' ' || text[i] === '\t') i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }

    if (atBoundary()) {
      let m = null;
      if (c === 'w') m = matchWww(text, i);
      if (!m && (c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
        m = matchScheme(text, i);
      }
      if (!m && (c === 'm' || c === 'M' || c === 'x' || c === 'X')) {
        m = matchMailtoXmpp(text, i);
      }
      if (!m && /[a-zA-Z0-9]/.test(c)) m = matchEmail(text, i);
      if (m) {
        flush();
        const href = m.email
          ? 'mailto:' + m.url
          : m.url.startsWith('www.')
            ? 'http://' + m.url
            : m.url;
        nodes.push({
          k: 'link',
          href,
          title: null,
          kids: [{ k: 'text', s: m.url }],
        });
        i = m.end;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  processEmphasis(0);
  return renderNodes(nodes);
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, state, tight) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, state, tight);
  return out;
}

function renderBlock(b, state, tight) {
  switch (b.type) {
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.text, state) + '</h' + b.level + '>\n';
    case 'paragraph':
      return tight
        ? renderInline(b.text, state)
        : '<p>' + renderInline(b.text, state) + '</p>\n';
    case 'code':
      return (
        '<pre><code' +
        (b.lang ? ' class="language-' + escAttr(b.lang) + '"' : '') +
        '>' +
        escText(b.text) +
        '</code></pre>\n'
      );
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.blocks, state, false) + '</blockquote>\n';
    case 'list':
      return renderList(b, state);
    case 'html':
      return b.text;
    case 'table':
      return renderTable(b, state);
    default:
      return '';
  }
}

function renderList(b, state) {
  const tag = b.ordered ? 'ol' : 'ul';
  let out =
    '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
  for (const item of b.items) {
    out += '<li>';
    const inputHtml = item.task
      ? '<input ' +
        (item.checked ? 'checked="" ' : '') +
        'disabled="" type="checkbox"> '
      : '';
    const parts = item.blocks.map((bl) => renderBlock(bl, state, !b.loose));
    if (item.task && b.loose && item.blocks.length > 0 && item.blocks[0].type === 'paragraph') {
      // In a loose list the checkbox lives inside the first paragraph.
      parts[0] =
        '<p>' + inputHtml + renderInline(item.blocks[0].text, state) + '</p>\n';
      out += parts.join('');
    } else {
      out += inputHtml + parts.join('');
    }
    out += '</li>\n';
  }
  return out + '</' + tag + '>\n';
}

function renderTable(b, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  b.header.forEach((cell, idx) => {
    const a = b.aligns[idx];
    out +=
      '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, state) + '</th>\n';
  });
  out += '</tr>\n</thead>\n';
  if (b.rows.length > 0) {
    out += '<tbody>';
    for (const row of b.rows) {
      out += '<tr>\n';
      row.forEach((cell, idx) => {
        const a = b.aligns[idx];
        out +=
          '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, state) + '</td>\n';
      });
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  if (typeof src !== 'string') src = src == null ? '' : String(src);
  src = src.replace(/\r\n|\r/g, '\n').replace(/\0/g, '\ufffd');
  const state = { defs: new Map(), srcEndsWithNewline: src.endsWith('\n') };
  const rawLines = src.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((s) => ({ s, lz: false }));
  const blocks = lexBlocks(lines, state, true);
  return renderBlocks(blocks, state, false);
}

export default parse;
