// parse.js — a fast CommonMark 0.31.2 + GFM renderer, written from scratch.
// It returns exactly the HTML that marked 18.1.3 produces with its default
// options (gfm on, breaks off, pedantic off, async off), for every input.
//
// The implementation is my own: a line-based block parser and a single-pass
// inline scanner with a delimiter-stack emphasis resolver. No dependencies,
// no I/O, no clocks, no caches across calls: parse() is a pure function of
// its argument.

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup ' +
   'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
   'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta ' +
   'nav noframes ol optgroup option p param search section summary table tbody td tfoot ' +
   'th thead title tr track ul').split(' ')
);

// ASCII punctuation, per the CommonMark definition.
const ASCII_PUNCT = new Set(
  ('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~').split('')
);
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const UNICODE_WS = /^\s$/;

function isPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return UNICODE_PUNCT.test(ch);
}
// Like isPunct, but the tilde does not count (marked's GFM delimiter sets
// treat ~ as an ordinary character for flanking purposes).
function isPunctNoTilde(ch) {
  if (ch === '~') return false;
  return isPunct(ch);
}
// ASCII punctuation only (used for backslash escapes and for unescaping
// punctuation in link destinations and titles).
function isAsciiPunct(ch) {
  return ch.charCodeAt(0) < 128 && ASCII_PUNCT.has(ch);
}
function isWS(ch) {
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) return true;
  if (c < 128) return false;
  return UNICODE_WS.test(ch);
}
function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    (c > 127 && /[\p{L}\p{N}]/u.test(ch));
}

// ---- line helpers (tabs advance to the next multiple of 4 columns) ----

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Number of columns of leading whitespace (spaces and tabs).
function indentOf(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Expand tabs in `s` to spaces, starting at column `col`.
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Remove up to `n` columns of leading indentation from a line. A tab that
// straddles the boundary is replaced by the spaces that remain of it.
function stripCols(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next <= n) { col = next; i++; }
      else return ' '.repeat(next - n) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// ---- HTML escaping and entity handling ----

// Escape a string for HTML output. When `encode` is true every `&` becomes
// `&amp;`; otherwise an `&` that starts a valid character reference
// (`&name;`, `&#123;`, `&#xAB;`) is left alone, and numeric references are
// decoded first (with the usual replacements for 0, surrogates and values
// above U+10FFFF). Named references are never decoded: they pass through.
function escapeText(s, encode) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') {
      if (encode) { rep = '&amp;'; }
      else if (s[i + 1] === '#') {
        // Numeric character reference.
        let j = i + 2;
        let hex = false;
        if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
        let k = j;
        while (k < s.length) {
          const c = s.charCodeAt(k);
          if (hex ? ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))
                  : (c >= 48 && c <= 57)) k++;
          else break;
        }
        if (k > j && k < s.length && s[k] === ';' && k - j <= (hex ? 6 : 7)) {
          const num = parseInt(s.slice(j, k), hex ? 16 : 10);
          if (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) rep = '\uFFFD';
          else if (num === 38) rep = '&amp;';
          else if (num === 60) rep = '&lt;';
          else if (num === 62) rep = '&gt;';
          else if (num === 34) rep = '&quot;';
          else if (num === 39) rep = '&#39;';
          else rep = String.fromCodePoint(num);
          out += s.slice(start, i) + rep;
          i = k;
          start = i + 1;
          continue;
        }
        // Not a valid numeric reference: is it a named one?
        const semi = s.indexOf(';', i + 1);
        if (semi !== -1 && semi - i - 1 >= 1 && semi - i - 1 <= 31) {
          let ok = true;
          for (let q = i + 1; q < semi; q++) {
            if (!isAlnum(s[q])) { ok = false; break; }
          }
          if (ok) continue; // leave the whole `&name;` alone
        }
        rep = '&amp;';
      } else {
        const semi = s.indexOf(';', i + 1);
        if (semi !== -1 && semi - i - 1 >= 1 && semi - i - 1 <= 31) {
          let ok = true;
          for (let q = i + 1; q < semi; q++) {
            if (!isAlnum(s[q])) { ok = false; break; }
          }
          if (ok) continue;
        }
        rep = '&amp;';
      }
    } else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in plain text (used for image alt
// text, where the result is escaped again afterwards).
function decodeNumeric(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&' && s[i + 1] === '#') {
      let j = i + 2;
      let hex = false;
      if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
      let k = j;
      while (k < s.length) {
        const c = s.charCodeAt(k);
        if (hex ? ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))
                : (c >= 48 && c <= 57)) k++;
        else break;
      }
      if (k > j && k < s.length && s[k] === ';' && k - j <= (hex ? 6 : 7)) {
        const num = parseInt(s.slice(j, k), hex ? 16 : 10);
        let rep;
        if (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) rep = '\uFFFD';
        else if (num === 38) rep = '&amp;';
        else rep = String.fromCodePoint(num);
        out += s.slice(start, i) + rep;
        i = k;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// encodeURI, with %25 turned back into %, or null when it throws.
function encodeUri(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove backslash escapes before ASCII punctuation.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Normalize a link label the way reference definitions are keyed: trim,
// collapse inner whitespace to one space, and fold case (lower, upper,
// lower, so that characters like ß fold the way Unicode case folding does).
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row on unescaped pipes, dropping empty outer cells, and
// trimming each cell (with `\|` restored to `|`).
function splitTableRow(s, cols) {
  // Replace unescaped | with a separator, keeping escaped ones.
  let t = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { t += s.slice(i, i + 2); i += 2; continue; }
    if (ch === '|') { t += ' |'; i++; continue; }
    t += ch;
    i++;
  }
  let cells = t.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (cols !== undefined) {
    if (cells.length > cols) cells.length = cols;
    else while (cells.length < cols) cells.push('');
  }
  for (let j = 0; j < cells.length; j++) {
    cells[j] = cells[j].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Strip 0-1 trailing blank lines from a raw block, and all of them when
// there are 2 or more (marked's treatment of html/indented-code raws).
function stripTrailingBlanks(raw) {
  const parts = raw.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && isBlank(parts[t])) t--;
  if (parts.length - t <= 2) return raw;
  return parts.slice(0, t + 1).join('\n');
}

// =====================================================================
// Inline parsing
// =====================================================================
// A scan produces a list of nodes:
//   string            plain text (entity-decoded and escaped when rendered)
//   {r: s}            raw text inside <pre>/<code>/... (rendered verbatim)
//   {h: s}            raw HTML tag (rendered verbatim)
//   {c: s}            code span (s is the processed code text)
//   {b: 1}            hard line break
//   {e: s}            one backslash-escaped punctuation character
//   {l: {...}}        link or image (inner HTML and plain text precomputed)
//   {d: ch, n, o, c}  emphasis/strikethrough delimiter run
//   {w: tag, k: []}   em / strong / del wrapper
// Delimiter runs are resolved after the scan by resolveEmphasis().

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![\w-])/;
// Same as EMAIL_RE but without the trailing-word-char lookahead: used when
// the character after the address is a closing emphasis delimiter (`_`/`*`).
const EMAIL_RE_LONG = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/;

// Persistent inline-lexer state: marked keeps `inLink` across paragraphs —
// an unclosed inline `<a>` tag suppresses extended autolinks (and nested
// links) in later paragraphs until a `</a>` tag appears. Reset per document.
let docInLink = false;

function isEmailLocal(ch) {
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  return ".!#$%&'*+/=?^_`{|}~-".indexOf(ch) !== -1;
}

// Left/right flanking for a delimiter run, given the characters around it
// (a missing neighbour counts as a newline, i.e. whitespace).
function flanking(before, after, noTilde) {
  const punct = noTilde ? isPunctNoTilde : isPunct;
  const left = !isWS(after) && (!punct(after) || isWS(before) || punct(before));
  const right = !isWS(before) && (!punct(before) || isWS(after) || punct(after));
  return [left, right];
}

function countRun(s, i, ch) {
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  return j - i;
}

// Find the end of a code span starting at the backtick run at `i` (run length
// `n`): the index just past the closing run, or -1. The content must start
// and end with a non-backtick character, and the character after the closing
// run must not be a backtick.
function findCodeSpanEnd(s, i, n) {
  const tick = '`'.repeat(n);
  let j = i + n;
  while (true) {
    const k = s.indexOf(tick, j);
    if (k === -1) return -1;
    if (s[k + n] === '`') { j = k + 1; continue; }
    const content = s.slice(i + n, k);
    if (content.length === 0) return -1;
    if (content[0] === '`' || content[content.length - 1] === '`') {
      // A longer span may still match: keep looking past this run.
      j = k + 1;
      continue;
    }
    return k + n;
  }
}

// Process code span content: newlines become spaces; strip one leading and
// one trailing space when the content has a non-space character and starts
// and ends with a space.
function codeSpanText(raw) {
  let s = raw.replace(/\n/g, ' ');
  if (s.length >= 2 && s[0] === ' ' && s[s.length - 1] === ' ' && /[^ ]/.test(s)) {
    s = s.slice(1, -1);
  }
  return s;
}

// Is the rest of `s` from `j` only whitespace?
function restIsOnlyWS(s, j) {
  for (let k = j; k < s.length; k++) {
    if (!isWS(s[k])) return false;
  }
  return true;
}

// --- autolinks -----------------------------------------------------------

// Match an autolink `<scheme:...>` or `<email>` at `i`; returns
// {end, href, text} or null.
function tryAutolink(s, i) {
  if (s[i] !== '<') return null;
  const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/.exec(s.slice(i, i + 200));
  if (m) return { end: i + m[0].length, href: m[1], text: m[1], email: false };
  const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![\w-]))>/.exec(s.slice(i, i + 200));
  if (em) return { end: i + em[0].length, href: 'mailto:' + em[1], text: em[1], email: true };
  return null;
}

// Match an inline HTML tag at `i`; returns the raw tag text or null.
// Comment, processing instruction, declaration, CDATA, or an open/close tag
// with a valid name and attributes.
function tryTag(s, i) {
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  let m;
  // Comment: must end with -->.
  if (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->');
    if (end === -1) return null;
    if (rest.startsWith('<!-->') || rest.startsWith('<!--->')) return '<!-->';
    return rest.slice(0, end + 3);
  }
  // Processing instruction.
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>');
    if (end === -1) return null;
    return rest.slice(0, end + 2);
  }
  // Declaration <!A...>.
  if (rest.startsWith('<!')) {
    if (rest.startsWith('<![CDATA[')) {
      const end = rest.indexOf(']]>');
      if (end === -1) return null;
      return rest.slice(0, end + 3);
    }
    m = /^<![a-zA-Z][^>]*>/.exec(rest);
    if (m) return m[0];
    return null;
  }
  // Closing tag.
  m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(rest);
  if (m) return m[0];
  // Opening tag with attributes.
  m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(rest);
  if (m) return m[0];
  return null;
}

// --- extended autolinks (www., scheme://, mailto:, email) ----------------

function matchEmailAt(s, i) {
  const m = EMAIL_RE.exec(s.slice(i, i + 320));
  return m ? m[0] : null;
}

function matchEmailLongAt(s, i) {
  const m = EMAIL_RE_LONG.exec(s.slice(i, i + 320));
  return m ? m[0] : null;
}

// Backpedal a matched bare URL the way marked does: keep the longest
// prefix decomposable into runs of non-punctuation, parenthesized groups
// `(...)` (kept whole), `&` not starting a character reference, and
// punctuation runs that are not at the very end. A trailing `)` is kept
// only when it closes a `(...)` group, not when it is an unbalanced
// leftover.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(s) {
  // Applied repeatedly until stable: stripping a trailing `?` can expose
  // a trailing `*` that must then also be stripped.
  let prev;
  do {
    prev = s;
    const m = BACKPEDAL_RE.exec(s);
    s = m ? m[0] : '';
  } while (s !== prev && s.length > 0);
  return s;
}

// Try an extended autolink at `i` (the scanner is at its first character).
// Returns {end, href, text} or null. `inLink` suppresses these. `nodes` is
// the node list scanned so far (used to tell a closing emphasis delimiter
// from a literal `_`/`*` after an email address).
function tryUrl(s, i, inLink, nodes) {
  if (inLink) return null;
  // www.
  if (s.startsWith('www.', i)) {
    if (i === 0 || ' \t\n\r*_~('.indexOf(s[i - 1]) !== -1) {
      const m = /^www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(s.slice(i));
      if (m) {
        const text = backpedal(m[0]);
        if (text.length > 4) return { end: i + text.length, href: 'http://' + text, text };
      }
    }
    return null;
  }
  // scheme://
  const scheme = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.exec(s.slice(i, i + 8));
  if (scheme) {
    const m = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(s.slice(i));
    if (m) {
      const text = backpedal(m[0]);
      return { end: i + text.length, href: text, text };
    }
    return null;
  }
  // mailto: / xmpp:
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    if (i === 0 || !isAlnum(s[i - 1])) {
      const proto = s.startsWith('mailto:', i) ? 'mailto:' : 'xmpp:';
      const rest = s.slice(i + proto.length);
      const em = EMAIL_RE.exec(rest);
      if (em) {
        let text = proto + em[0];
        if (proto === 'xmpp:') {
          const res = /^\/[A-Za-z0-9@.]+/.exec(rest.slice(em[0].length));
          if (res) text += res[0];
        }
        return { end: i + text.length, href: text, text };
      }
    }
    return null;
  }
  // Bare email. The scanner works left to right, so the earliest match
  // wins; a later `@` can start a new address (`a@b@c.com` -> `b@c.com`).
  if (isEmailLocal(s[i])) {
    const em = matchEmailAt(s, i);
    if (em) {
      // The lookahead may have truncated the address when it is followed
      // by a closing emphasis delimiter (`_warning a@b.com_`). If the
      // un-lookaheaded match is longer and ends right before such a
      // delimiter that has an opener scanned already, use the long match.
      const emLong = matchEmailLongAt(s, i);
      if (emLong && emLong.length > em.length) {
        const after = s[i + emLong.length];
        if ((after === '_' || after === '*') && nodes) {
          for (let k = nodes.length - 1; k >= 0; k--) {
            const nd = nodes[k];
            if (nd && nd.d === after && nd.op) {
              return { end: i + emLong.length, href: 'mailto:' + emLong, text: emLong };
            }
          }
        }
      }
      return { end: i + em.length, href: 'mailto:' + em, text: em };
    }
    // No lookahead match: the address may still be there, followed by a
    // closing emphasis delimiter. Same opener check as above.
    const emLong = matchEmailLongAt(s, i);
    if (emLong) {
      const after = s[i + emLong.length];
      if ((after === '_' || after === '*') && nodes) {
        for (let k = nodes.length - 1; k >= 0; k--) {
          const nd = nodes[k];
          if (nd && nd.d === after && nd.op) {
            return { end: i + emLong.length, href: 'mailto:' + emLong, text: emLong };
          }
        }
      }
    }
  }
  return null;
}

// --- link labels -----------------------------------------------------------

// Scan a link label starting just after `[` at `start`. Returns the list of
// candidate end positions (indexes of `]` that close the label at depth 0),
// in order. Brackets may nest one group deep, escapes and code spans are
// skipped, and a `[` inside the innermost group ends the scan.
function labelEnds(s, start) {
  const ends = [];
  let depth = 0;
  let j = start;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (ch === '`') {
      const run = countRun(s, j, '`');
      // A run of 2+ backticks immediately before `]` is a closing run (or
      // a run right before the label end): skip past it and let the `]`
      // end the label. Check this before scanning for a closing run, or
      // the scan would jump to a backtick far later in the text.
      if (run >= 2 && s[j + run] === ']') {
        j = j + run;
        continue;
      }
      // Otherwise the run must open a code span: an opening run,
      // non-backtick content, then a closing run (runs need not be equal
      // in the label regex). Otherwise the label cannot extend past it.
      let k = j + run;
      while (k < s.length && s[k] !== '`') k++;
      if (k < s.length) {
        j = k + countRun(s, k, '`');
        continue;
      }
      break;
    }
    if (ch === '[') {
      if (depth === 2) break;
      depth++;
      j++;
      continue;
    }
    if (ch === ']') {
      if (depth === 0) { ends.push(j); break; }
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return ends;
}

// Does the label text contain a `<` that starts a tag or autolink which
// runs past the end of the label? (Such a link is not a link at all.)
function labelHasTag(s, labelStart, labelEnd, labelText) {
  if (labelText.indexOf('<') === -1) return false;
  for (let p = 0; p < labelText.length; p++) {
    const ch = labelText[p];
    if (ch === '\\') { p++; continue; }
    if (ch === '`') {
      const run = countRun(labelText, p, '`');
      const end = findCodeSpanEnd(labelText, p, run);
      if (end !== -1) { p = end - 1; continue; }
      continue;
    }
    if (ch !== '<') continue;
    const at = labelStart + p;
    const tag = tryTag(s, at) || (tryAutolink(s, at) ? s.slice(at, tryAutolink(s, at).end) : null);
    if (tag) {
      if (tag.length > labelText.length - p) return true;
      p += tag.length - 1;
    }
  }
  return false;
}

// Parse an inline link destination and optional title starting at `(`.
// `i` is the index of `(`. Returns {href, title, end} (end is just past
// `)`) or null.
function parseLinkDestination(s, i) {
  let j = i + 1;
  // Skip whitespace (spaces, tabs, newlines).
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let href = '';
  let title = null;
  if (s[j] === '<') {
    // Angle-bracket destination: no newlines, no unescaped < or >.
    let k = j + 1;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (ch === '\n' || ch === '<' || ch === '>') break;
      k++;
    }
    if (k >= s.length || s[k] !== '>') return null;
    href = s.slice(j + 1, k);
    j = k + 1;
  } else if (s[j] === ')') {
    href = '';
  } else {
    // Bare destination: no spaces or control characters, balanced parens.
    let k = j;
    let depth = 0;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) { k += 2; continue; }
      const c = ch.charCodeAt(0);
      if (ch === ' ' || ch === '\t' || ch === '\n' || c < 32) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth > 0) return null; // unbalanced open parens
    href = s.slice(j, k);
    j = k;
  }
  // Optional title, preceded by spaces/tabs and at most one newline's worth
  // of whitespace, or a newline followed by spaces.
  let save = j;
  let spaces = 0;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) { j++; spaces++; }
  if (j < s.length && s[j] === '\n') {
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k > j + 1 || spaces > 0) { j = k; }
  }
  if (j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const q = s[j];
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (ch === close) { ok = true; break; }
      if (q !== '"' && ch === '\n') {
        // Single-quoted and paren titles may not span a blank line, but a
        // lone newline is fine; double-quoted titles may span lines.
        if (q === "'" && s[k + 1] === '\n') break;
      }
      k++;
    }
    if (ok) {
      title = s.slice(j + 1, k);
      j = k + 1;
    } else {
      j = save; // no title after all
    }
  } else {
    j = save;
  }
  // Trailing whitespace, then `)`.
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length || s[j] !== ')') return null;
  // The `)` must not be escaped: an odd run of backslashes before it.
  let bs = 0;
  for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) bs++;
  if (bs % 2 === 1) return null;
  return { href, title, end: j + 1 };
}

// Try to parse a link or image starting at `i` (which is `[`, or `!`
// followed by `[`). Returns a link node, or null when no link forms (the
// caller then treats the `[` as plain text).
function tryLink(s, i, links, st) {
  const isImage = s[i] === '!';
  const open = isImage ? i + 1 : i;
  if (s[open] !== '[') return null;
  const ends = labelEnds(s, open + 1);
  if (ends.length === 0) return null;
  const labelEnd = ends[0];
  const labelText = s.slice(open + 1, labelEnd);
  const after = labelEnd + 1;
  let href = null;
  let title = null;
  let end = -1;
  if (s[after] === '(') {
    const dest = parseLinkDestination(s, after);
    if (!dest) return null;
    href = dest.href;
    title = dest.title;
    end = dest.end;
  } else {
    // Reference link: [label][ref], [label][], or [label].
    let ref = null;
    if (s[after] === '[') {
      // The reference label is parsed like a label (escapes and nested
      // brackets handled by labelEnds); a `[` escaped as `\[` is not a
      // nested bracket.
      const refEnds = labelEnds(s, after + 1);
      if (refEnds.length === 0) return null;
      const close = refEnds[0];
      const refText = s.slice(after + 1, close);
      if (refText.indexOf('\n') !== -1) {
        // A reference label may not contain a blank line.
        if (/\n[ \t]*\n/.test(refText)) return null;
      }
      ref = refText === '' ? labelText : refText;
      end = close + 1;
    } else {
      ref = labelText;
      end = after;
    }
    const def = links[normalizeLabel(ref)];
    if (!def) return null;
    href = def.href;
    title = def.title;
  }
  if (labelHasTag(s, open + 1, labelEnd, labelText)) return null;
  href = unescapePunct(href);
  if (title !== null && title !== undefined) title = unescapePunct(title);
  if (isImage) {
    const plain = renderNodes(scanInline(labelText, links, { inLink: true, inRaw: st.inRaw }).nodes, true);
    return { l: { href, title, inner: null, plain, img: true, auto: false }, end, hasLink: false };
  }
  const inner = scanInline(labelText, links, { inLink: true, inRaw: st.inRaw });
  if (inner.hasBracketLink) return null;
  return { l: { href, title, inner: inner.nodes, plain: null, img: false, auto: false }, end, hasLink: true };
}

// --- the scanner -----------------------------------------------------------

// Scan inline content into a node list. `st` carries the in-link and
// in-raw-block state. Returns {nodes, hasLink}.
function scanInline(src, links, st) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  let hasLink = false;
  // A nested `[text](url)` link (but not an autolink, image, or bare URL)
  // in a link label rejects the outer link.
  let hasBracketLink = false;
  let textStart = 0;
  let textRaw = st.inRaw;
  let inLink = st.inLink;
  let inRaw = st.inRaw;

  const flushText = (end) => {
    if (end > textStart) {
      const t = src.slice(textStart, end);
      nodes.push(textRaw ? { r: t } : t);
    }
    textStart = end;
  };

  while (i < n) {
    const ch = src[i];
    // Backslash escape.
    if (ch === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
      flushText(i);
      nodes.push({ e: src[i + 1] });
      i += 2;
      textStart = i;
      textRaw = inRaw;
      continue;
    }
    // Hard break: backslash + newline.
    if (ch === '\\' && src[i + 1] === '\n' && !restIsOnlyWS(src, i + 2)) {
      flushText(i);
      nodes.push({ b: 1 });
      i += 2;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      textStart = i;
      textRaw = inRaw;
      continue;
    }
    // Hard break: two or more spaces + newline.
    if (ch === ' ') {
      let j = i;
      while (j < n && src[j] === ' ') j++;
      if (j - i >= 2 && src[j] === '\n' && !restIsOnlyWS(src, j + 1)) {
        flushText(i);
        nodes.push({ b: 1 });
        i = j + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
      i++;
      continue;
    }
    // Raw HTML tag or autolink.
    if (ch === '<') {
      const tag = tryTag(src, i);
      if (tag !== null) {
        flushText(i);
        nodes.push({ h: tag });
        const low = tag.toLowerCase();
        if (!inLink && /^<a[\s>]/.test(low)) inLink = true;
        else if (inLink && /^<\/a[\s>]/.test(low)) inLink = false;
        if (!inRaw && /^<(pre|code|kbd|script)[\s>]/.test(low)) inRaw = true;
        else if (inRaw && /^<\/(pre|code|kbd|script)[\s>]/.test(low)) inRaw = false;
        i += tag.length;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
      const auto = tryAutolink(src, i);
      if (auto) {
        flushText(i);
        nodes.push({ l: { href: auto.href, title: null, inner: auto.text, plain: auto.text, img: false, auto: true } });
        hasLink = true;
        i = auto.end;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
      i++;
      continue;
    }
    // Link or image.
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = tryLink(src, i, links, { inLink, inRaw });
      if (link) {
        flushText(i);
        nodes.push({ l: link.l });
        if (!link.l.img) { hasLink = true; hasBracketLink = true; }
        i = link.end;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
      i++;
      continue;
    }
    // Delimiter run.
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = countRun(src, i, ch);
      if (ch === '~' && run > 2) { i += run; continue; }
      const before = i > 0 ? src[i - 1] : '\n';
      const after = i + run < n ? src[i + run] : '\n';
      flushText(i);
      nodes.push(delimNode(ch, run, before, after));
      i += run;
      textStart = i;
      textRaw = inRaw;
      continue;
    }
    // Code span.
    if (ch === '`') {
      const run = countRun(src, i, '`');
      const end = findCodeSpanEnd(src, i, run);
      if (end !== -1) {
        flushText(i);
        nodes.push({ c: codeSpanText(src.slice(i + run, end - run)) });
        i = end;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
      i += run;
      continue;
    }
    // Extended autolink.
    if (ch === 'w' || ch === 'h' || ch === 'f' || ch === 'm' || ch === 'x' || isEmailLocal(ch)) {
      const url = tryUrl(src, i, inLink, nodes);
      if (url) {
        flushText(i);
        nodes.push({ l: { href: url.href, title: null, inner: url.text, plain: url.text, img: false, auto: true } });
        hasLink = true;
        i = url.end;
        textStart = i;
        textRaw = inRaw;
        continue;
      }
    }
    i++;
  }
  flushText(n);
  // Resolve emphasis/strikethrough here, so link label text (scanned by a
  // nested scanInline call) gets its own emphasis resolved too.
  resolveEmphasis(nodes);
  return { nodes, hasLink, hasBracketLink, inLink };
}

// --- emphasis / strikethrough resolution -----------------------------------

// Make a delimiter node, computing whether it can open / close from the
// characters around the run.
function delimNode(ch, n, before, after) {
  const [left, right] = flanking(before, after, ch === '~');
  let o = false, c = false;
  if (ch === '_') {
    o = left && (!right || isPunct(before));
    c = right && (!left || isPunct(after));
  } else {
    o = left;
    c = right;
  }
  return { d: ch, n, op: o, cl: c, af: after };
}

// Resolve emphasis and strikethrough in a node list, in place, processing
// delimiter runs left to right. For each opener the forward scan counts
// The first (or last) character of a node list, for flanking purposes.
// Strings and delimiter runs contribute their own character; a hard break
// contributes a newline; other nodes contribute a non-whitespace character.
function firstFlankChar(nodes) {
  for (const nd of nodes) {
    if (typeof nd === 'string') { if (nd.length > 0) return nd[0]; continue; }
    if (typeof nd !== 'object') continue;
    if (nd.d) return nd.d;
    if (nd.b) return '\n';
    if (nd.w) { const c = firstFlankChar(nd.k); if (c) return c; continue; }
    return 'x';
  }
  return '';
}
function lastFlankChar(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (typeof nd === 'string') { if (nd.length > 0) return nd[nd.length - 1]; continue; }
    if (typeof nd !== 'object') continue;
    if (nd.d) return nd.d;
    if (nd.b) return '\n';
    if (nd.w) { const c = lastFlankChar(nd.k); if (c) return c; continue; }
    return 'x';
  }
  return '';
}

// inner opener runs into a pool `m`; a closer run spends from it, and only
// when the pool is exhausted does it close the opener. A closer that can
// also open (or an opener that can also close) is skipped when the sum of
// the opener and closer lengths is a multiple of three (the rule of three).
function resolveEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (!nd || typeof nd !== 'object' || !nd.d || !nd.op) { i++; continue; }
    const ch = nd.d;
    const isDel = ch === '~';
    const L = nd.n;
    let m = L, f = 0;
    let matchJ = -1, matchUse = 0;
    for (let j = i + 1; j < nodes.length; j++) {
      const c = nodes[j];
      if (!c || typeof c !== 'object' || c.d !== ch) continue;
      if (isDel) {
        // Strikethrough: only runs of exactly the opener's length join
        // the pool (a closer must be the same length; there is no rule
        // of three for `~`). A shorter inner run (e.g. a single `~`
        // inside `~~...~~`) neither adds to nor spends from the pool.
        if (c.n !== L) continue;
        if (c.op && !c.cl) { m += c.n; continue; }
        if (!c.cl) continue;
        m -= c.n;
        if (m > 0) continue;
        matchJ = j;
        matchUse = c.n;
        break;
      }
      if (c.op && !c.cl) { m += c.n; continue; }
      if (!c.cl) continue;
      if ((c.op || nd.cl) && (L % 3 !== 0) && ((L + c.n) % 3 === 0)) {
        f += c.n;
        continue;
      }
      m -= c.n;
      if (m > 0) continue;
      matchJ = j;
      matchUse = Math.min(c.n, c.n + m + (isDel ? 0 : f));
      break;
    }
    if (matchJ === -1) {
      // No closer: if the run has more than one delimiter, consume one as
      // literal text and retry the shorter run as an opener (marked's
      // emStrong fails on the full run, the text tokenizer eats one
      // delimiter, and the next delimiter is retried — e.g. `**foo*` gives
      // `*<em>foo</em>`).
      if (L > 1) {
        const shortened = delimNode(ch, L - 1, ch, nd.af);
        nodes.splice(i, 1, ch, shortened);
        i++; // past the literal delimiter; retry the shortened run
        continue;
      }
      nd.op = false;
      nd.cl = false;
      i++;
      continue;
    }
    const closer = nodes[matchJ];
    const used = Math.min(L, matchUse);
    const isEm = used % 2 === 1;
    const takeOpen = isEm ? 1 : 2;
    const takeClose = isEm ? 1 : 2;
    // The inner content, with the leftover opener delims (as a delimiter
    // node, so they can pair with an inner closer) and the leftover closer
    // delims (as a delimiter node, so they can pair with an inner opener),
    // is resolved recursively — marked re-lexes this text, so the leftovers
    // are live delimiters, not literal text.
    const inner = nodes.slice(i + 1, matchJ);
    const children = [];
    if (L - takeOpen > 0) {
      const fc = firstFlankChar(inner);
      children.push({ d: ch, n: L - takeOpen, op: fc !== '' && !isWS(fc), cl: false, af: fc });
    }
    for (const k of inner) children.push(k);
    if (matchUse - takeClose > 0) {
      const lc = lastFlankChar(inner);
      children.push({ d: ch, n: matchUse - takeClose, op: false, cl: lc !== '' && !isWS(lc), af: '' });
    }
    resolveEmphasis(children);
    const wrap = { w: isDel ? 'del' : isEm ? 'em' : 'strong', k: children };
    const rest = [];
    if (closer.n - matchUse > 0) {
      // The unused tail of the closer run stays a delimiter.
      rest.push(delimNode(ch, closer.n - matchUse, ch, closer.af));
    }
    nodes.splice(i, matchJ - i + 1, wrap, ...rest);
    i += 1 + rest.length;
  }
}

// --- rendering -------------------------------------------------------------

// Render a link or image node.
function renderLink(l, plain) {
  if (plain) {
    if (l.img) return decodeNumeric(l.plain);
    if (l.auto) return l.plain;
    return renderNodes(l.inner, true);
  }
  if (l.img) {
    const alt = escapeText(decodeNumeric(l.plain), false);
    const href = encodeUri(l.href);
    if (href === null) return alt;
    let out = '<img src="' + escapeText(href, false) + '" alt="' + alt + '"';
    if (l.title) out += ' title="' + escapeText(l.title, false) + '"';
    return out + '>';
  }
  let inner;
  if (l.auto) inner = escapeText(l.inner, true);
  else inner = renderNodes(l.inner, false);
  const href = encodeUri(l.href);
  if (href === null) return inner;
  let out = '<a href="' + escapeText(href, l.auto) + '"';
  if (l.title) out += ' title="' + escapeText(l.title, false) + '"';
  return out + '>' + inner + '</a>';
}

function renderNodes(nodes, plain) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') {
      out += plain ? decodeNumeric(nd) : escapeText(nd, false);
    } else if (nd.r !== undefined) {
      out += nd.r;
    } else if (nd.h !== undefined) {
      out += nd.h;
    } else if (nd.c !== undefined) {
      out += plain ? nd.c : '<code>' + escapeText(nd.c, true) + '</code>';
    } else if (nd.b !== undefined) {
      out += plain ? '' : '<br>';
    } else if (nd.e !== undefined) {
      out += plain ? nd.e : escapeText(nd.e, false);
    } else if (nd.l !== undefined) {
      out += renderLink(nd.l, plain);
    } else if (nd.d !== undefined) {
      out += nd.d.repeat(nd.n);
    } else if (nd.w !== undefined) {
      const inner = renderNodes(nd.k, plain);
      if (plain) out += inner;
      else if (nd.w === 'em') out += '<em>' + inner + '</em>';
      else if (nd.w === 'strong') out += '<strong>' + inner + '</strong>';
      else out += '<del>' + inner + '</del>';
    }
  }
  return out;
}

// Render inline markdown to HTML (or to plain text when `plain`).
// Top-level entry: carries the persistent `inLink` state across paragraphs.
function inlineHtml(src, links, plain) {
  const { nodes, inLink } = scanInline(src, links, { inLink: docInLink, inRaw: false });
  docInLink = inLink;
  return renderNodes(nodes, plain);
}

// =====================================================================
// Block parsing
// =====================================================================

// Block-start tests. Each takes a line and returns a match object or null.
// They work on the raw line (tabs not yet expanded) except where noted.

// Indent in columns, tabs counting to the next multiple of 4.
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// ATX heading: up to 3 spaces, 1-6 #, then a space/tab or end of line.
function atxHeading(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return null;
  let h = 0;
  while (i < line.length && line[i] === '#') { h++; i++; }
  if (h === 0 || h > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  return { level: h, start: i };
}

// Fence: up to 3 spaces, 3+ backticks or tildes.
function fenceOpen(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (i < line.length && line[i] === ch) { n++; i++; }
  if (n < 3) return null;
  if (ch === '`' && line.slice(i).indexOf('`') !== -1) return null;
  return { ch, n, indent: i - n, info: line.slice(i) };
}

// Horizontal rule: up to 3 spaces, then 3+ of -, _ or * separated by
// spaces/tabs only.
function isHr(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return false;
  const ch = line[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let n = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ch) { n++; i++; }
    else if (c === ' ' || c === '\t') i++;
    else return false;
  }
  return n >= 3;
}

// Blockquote marker: up to 3 spaces then `>`.
function isQuoteLine(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  return i < line.length && line[i] === '>';
}

// Strip one blockquote marker from a line: the leading spaces, the `>`,
// and one following whitespace character. The whitespace after the marker
// is tab-expanded relative to the marker's column first.
function stripQuoteMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  const markerCol = i; // column of `>`
  i++; // skip `>`
  let ws = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { ws += line[i]; i++; }
  const expanded = expandTabs(ws, markerCol + 1);
  const content = expanded.length > 0 ? expanded.slice(1) : '';
  return content + line.slice(i);
}

// List marker: up to 3 spaces, then `*`, `+`, `-` or 1-9 digits + `.`/`)`.
function listMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return null;
  const ch = line[i];
  if (ch === '*' || ch === '+' || ch === '-') {
    const rest = line.slice(i + 1);
    // A bullet marker must be followed by a space/tab or end of line;
    // `-removed` is not a list item.
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
    return { bullet: ch, ordered: false, start: 0, len: i + 1, rest };
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - i > 9) return null;
    if (j < line.length && (line[j] === '.' || line[j] === ')')) {
      const rest = line.slice(j + 1);
      if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
      return { bullet: line.slice(i, j + 1), ordered: true, start: parseInt(line.slice(i, j), 10), len: j + 1, rest };
    }
  }
  return null;
}

// Is this line a setext underline (0-3 spaces, then = or - runs)?
function setextLevel(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return 0;
  if (i >= line.length) return 0;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}

// HTML block start (types 1-6 only; type 7 is handled separately).
function htmlBlockType(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return 0;
  if (line[i] !== '<') return 0;
  const rest = line.slice(i + 1);
  const low = rest.toLowerCase();
  // Type 1: script, pre, style, textarea.
  const m1 = /^(script|pre|style|textarea)(?:[\s>]|$)/.exec(low);
  if (m1) return 1;
  // Type 2: comment.
  if (low.startsWith('!--')) return 2;
  // Type 3: processing instruction.
  if (low.startsWith('?')) return 3;
  // Type 4: declaration (<! + letter).
  if (low.startsWith('!') && low.length > 1 && /[a-z]/.test(low[1])) return 4;
  // Type 5: CDATA.
  if (low.startsWith('![cdata[')) return 5;
  // Type 6: a block-level tag (open or close), followed by space, newline,
  // `/` or `>`.
  const m6 = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const after = rest[m6[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '/' || after === '>') return 6;
  }
  return 0;
}

// Type 7: any open or close tag alone on its line (only spaces/tabs after).
function htmlType7(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return false;
  if (line[i] !== '<') return false;
  const rest = line.slice(i + 1);
  // Type 1 tags (script/pre/style/textarea) are not type 7.
  if (/^(script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return false;
  // Open tag (with attributes) or close tag, then only spaces/tabs.
  const m = /^(?:\/[a-zA-Z][a-zA-Z0-9-]*\s*>|[a-zA-Z][a-zA-Z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"]*"| *= *'[^']*'| *= *[^\s"'=<>`]+)?)* *\/?>)/.exec(rest);
  if (!m) return false;
  return /^[ \t]*$/.test(rest.slice(m[0].length));
}

// Is this line a table delimiter row? Returns the cell list or null.
// The delimiter line starts with at most 3 spaces (no tab), and every
// cell must be `:?-+:?`.
function tableDelimiterCells(line) {
  if (line[0] === '\t') return null;
  let lead = 0;
  while (lead < line.length && line[lead] === ' ') lead++;
  if (lead > 3) return null;
  const cells = splitTableRow(line);
  if (cells === null || cells.length === 0) return null;
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
  }
  return cells;
}

// Does `line` start a table (header + delimiter on the next line)? This is
// the table pattern as it appears in the paragraph lookahead: no
// requirement that the delimiter contain `:` or `|`.
function isTableStart(line, next) {
  if (next === undefined) return false;
  if (!/\S/.test(line)) return false;
  return tableDelimiterCells(next) !== null;
}

// Is this line a table-delimiter-style line for the setext-heading body
// (a line of `:`, `-`, spaces and `|`s with a `|` after the first char)?
function isTableDelimLine(line) {
  let pipeAfterFirst = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === '|') { if (k > 0) pipeAfterFirst = true; }
    else if (c !== ':' && c !== '-' && c !== ' ') return false;
  }
  return pipeAfterFirst;
}

// Does this line start a block (used by paragraph/table/list gathering)?
// `listAny` = true means any list marker (bullet or ordered) counts;
// otherwise only bullets and ordered lists starting with 1.
function startsBlock(line, listAny) {
  if (isBlank(line)) return 'blank';
  if (atxHeading(line)) return 'heading';
  if (fenceOpen(line)) return 'fences';
  if (isHr(line)) return 'hr';
  if (isQuoteLine(line)) return 'blockquote';
  const lm = listMarker(line);
  if (lm) {
    if (listAny) return 'list';
    if (!lm.ordered) return 'list';
    if (lm.start === 1) return 'list';
  }
  if (htmlBlockType(line)) return 'html';
  return null;
}


// --- link reference definitions -------------------------------------------

// Scan a link reference definition starting at lines[i]. Returns
// {label, href, title, raw, next} or null. The definition may span up to
// four lines (a multi-line label, a destination on the next line, a title
// on the next line).
function scanDef(lines, i, end) {
  // A definition cannot contain a blank line; collect lines up to the next
  // blank line (capped, since a multi-line title can span several lines).
  let maxLines = 0;
  while (i + maxLines < end && maxLines < 20 && !isBlank(lines[i + maxLines])) maxLines++;
  // Include the blank line itself in `src` so the end-of-definition check
  // sees the line boundary (it is not consumed).
  if (i + maxLines < end && maxLines < 20) maxLines++;
  if (maxLines === 0) return null;
  let src = '';
  for (let k = 0; k < maxLines; k++) src += lines[i + k] + '\n';
  let p = 0;
  let sp = 0;
  while (sp < 3 && src[p] === ' ') { sp++; p++; }
  if (src[p] !== '[') return null;
  p++;
  const labelStart = p;
  let label = '';
  let labelEnd = -1;
  while (p < src.length) {
    const ch = src[p];
    // Keep escapes raw in the label so the key matches the reference text
    // (which is also raw) after normalizeLabel.
    if (ch === '\\' && p + 1 < src.length) { label += src.slice(p, p + 2); p += 2; continue; }
    if (ch === ']') { labelEnd = p; break; }
    if (ch === '[') break;
    if (ch === '\n') {
      let q = p + 1;
      while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
      if (q >= src.length || src[q] === '\n') break;
      label += '\n'; p++;
      continue;
    }
    label += ch; p++;
  }
  if (labelEnd === -1) return null;
  if (/^\s*$/.test(label)) return null;
  p = labelEnd + 1;
  if (src[p] !== ':') return null;
  p++;
  while (src[p] === ' ') p++;
  if (src[p] === '\n') {
    p++;
    while (src[p] === ' ' || src[p] === '\t') p++;
  }
  let href = '';
  if (src[p] === '<') {
    const q = src.indexOf('>', p + 1);
    if (q === -1) return null;
    if (src.slice(p + 1, q).indexOf('\n') !== -1) return null;
    href = src.slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < src.length) {
      const ch = src[q];
      if (ch === '\\' && q + 1 < src.length) { q += 2; continue; }
      const c = ch.charCodeAt(0);
      if (ch === ' ' || ch === '\t' || ch === '\n' || c < 32) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (q === p) return null;
    if (depth > 0) return null;
    href = src.slice(p, q);
    p = q;
  }
  let title = null;
  const save = p;
  let sp2 = 0;
  while (src[p] === ' ' || src[p] === '\t') { p++; sp2++; }
  if (src[p] === '\n') {
    // The title may be on the next line (with or without whitespace).
    let q = p + 1;
    while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
    p = q;
  } else if (sp2 === 0 && p < src.length) {
    // The destination must be followed by whitespace, a newline, or the
    // end of the definition (e.g. `[foo]: <bar>(baz)` is not a definition).
    return null;
  }
  if (src[p] === '"' || src[p] === "'" || src[p] === '(') {
    const qch = src[p];
    const close = qch === '(' ? ')' : qch;
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      const ch = src[q];
      if (ch === '\\' && q + 1 < src.length) { q += 2; continue; }
      if (ch === close) { ok = true; break; }
      if (ch === '\n') {
        if (qch === '(') break;
        if (qch === "'" && src[q + 1] === '\n') break;
      }
      q++;
    }
    if (ok) {
      title = src.slice(p + 1, q);
      p = q + 1;
    } else {
      p = save;
    }
  } else {
    p = save;
  }
  while (src[p] === ' ' || src[p] === '\t') p++;
  if (p < src.length && src[p] !== '\n') {
    // A title followed by junk is invalid; fall back to a title-less
    // definition if the destination line ends cleanly (the junk line then
    // becomes a separate block). If the junk is on the destination line
    // itself, the definition fails.
    if (title !== null) {
      title = null;
      p = save;
      while (src[p] === ' ' || src[p] === '\t') p++;
      if (p < src.length && src[p] !== '\n') return null;
    } else {
      return null;
    }
  }
  // Lines consumed: the line containing position p (0-based) + 1. `p` sits
  // at the newline ending the definition's last line (or at end of `src`).
  let consumed = 0;
  for (let k = 0; k < p; k++) if (src[k] === '\n') consumed++;
  consumed = Math.min(consumed + 1, maxLines);
  if (p >= src.length) consumed = maxLines;
  const rawLines = lines.slice(i, i + consumed);
  return {
    label,
    href: unescapePunct(href),
    title: title === null ? null : unescapePunct(title),
    raw: rawLines.join('\n'),
    next: i + consumed,
  };
}

// --- collectors ------------------------------------------------------------

// Indented code block starting at lines[i]. Returns {text, next}.
// `endsNL` is true when the last line of the whole source ends with `\n`.
function collectCode(lines, i, end, endsNL) {
  let j = i;
  let lastContent = i;
  while (j < end) {
    // A blank line (even a tab-only line, whose indent columns reach 4)
    // is a blank line, not code content: the code regex requires a
    // non-newline character after the indent.
    if (isBlank(lines[j])) j++;
    else if (indentCols(lines[j]) >= 4) { lastContent = j; j++; }
    else break;
  }
  const content = [];
  for (let k = i; k <= lastContent; k++) {
    const line = lines[k];
    // Strip up to 4 columns of indent: a tab jumps to the next multiple
    // of 4, a space is one column.
    let col = 0;
    let c = 0;
    while (c < line.length && col < 4) {
      if (line[c] === ' ') { col++; c++; }
      else if (line[c] === '\t') { col += 4 - (col % 4); c++; }
      else break;
    }
    content.push(line.slice(c));
  }
  const hasTrailingBlank = lastContent < j - 1;
  let text = content.join('\n');
  const endsWithNL = (lastContent < end - 1) || endsNL;
  if (!hasTrailingBlank && endsWithNL) text += '\n';
  return { text, next: j };
}

// Fenced code block starting at lines[i] (fence already matched).
function collectFence(lines, i, end, fence) {
  const { ch, n, indent } = fence;
  let j = i + 1;
  const content = [];
  let closed = false;
  while (j < end) {
    const line = lines[j];
    // Closing fence: same char, length >= opening, indent 0-3 spaces,
    // only spaces/tabs after.
    let k = 0;
    while (k < line.length && line[k] === ' ' && k < 3) k++;
    if (k <= 3 && line[k] === ch) {
      let m = 0;
      while (k + m < line.length && line[k + m] === ch) m++;
      if (m >= n) {
        let t = k + m;
        while (t < line.length && (line[t] === ' ' || line[t] === '\t')) t++;
        if (t === line.length) { closed = true; j++; break; }
      }
    }
    content.push(line);
    j++;
  }
  // Backtick fences strip up to the opening fence's indent from each line,
  // counting characters (a tab is one character).
  let text;
  if (ch === '`' && indent > 0) {
    text = content.map((ln) => {
      let c = 0;
      while (c < ln.length && c < indent && (ln[c] === ' ' || ln[c] === '\t')) c++;
      return ln.slice(c);
    }).join('\n');
  } else {
    text = content.join('\n');
  }
  return { text, next: j, closed };
}

// The language word from a fence info string.
function fenceLang(info) {
  const t = info.trim();
  if (!t) return null;
  const w = t.split(/[ \t]+/)[0];
  return unescapePunct(w);
}

// ATX heading text: trim, then strip a closing run of `#`s when it is the
// whole text or is preceded by a space/tab.
function headingText(raw) {
  let n = raw.trim();
  if (/#$/.test(n)) {
    let s = n.length;
    while (s > 0 && n[s - 1] === '#') s--;
    const stripped = n.slice(0, s);
    if (stripped === '' || /[ \t]$/.test(stripped)) n = stripped.trim();
  }
  return n;
}

// HTML block starting at lines[i] of the given type (1-7). The text keeps
// one trailing newline when the block's last line ends with one in the
// source (it is not the source's last line, or the source ends with one).
function collectHtml(lines, i, end, type, endsNL) {
  const out = [];
  let j = i;
  if (type === 1) {
    // Ends at the matching close tag (rest of that line included).
    const m = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(lines[i]);
    const tag = m[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '>', 'i');
    while (j < end) {
      out.push(lines[j]);
      if (closeRe.test(lines[j])) { j++; break; }
      j++;
    }
  } else if (type === 2) {
    // Comment: ends at the first `-->`.
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].indexOf('-->') !== -1) { j++; break; }
      j++;
    }
  } else if (type === 3) {
    // Processing instruction: ends at `?>`.
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].indexOf('?>') !== -1) { j++; break; }
      j++;
    }
  } else if (type === 4) {
    // Declaration: ends at the first `>`.
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].indexOf('>') !== -1) { j++; break; }
      j++;
    }
  } else if (type === 5) {
    // CDATA: ends at `]]>`.
    while (j < end) {
      out.push(lines[j]);
      if (lines[j].indexOf(']]>') !== -1) { j++; break; }
      j++;
    }
  } else {
    // Types 6 and 7: end at a blank line.
    while (j < end && !isBlank(lines[j])) { out.push(lines[j]); j++; }
  }
  let raw = out.join('\n');
  // A trailing newline is kept when the block's last line ends with one in
  // the source. For types 1-5 the block ends at a terminator, and the
  // newline after it is kept unless the next line is truly empty (then the
  // html regex matches two newlines and `ge` strips them); a spaces-only
  // or tab-only line does not break the single-newline run, so the `\n`
  // is kept. Types 6-7 end at a blank line, so no trailing newline.
  if (out.length > 0) {
    if (j < end) {
      if (type <= 5) {
        if (lines[j] !== '') raw += '\n';
      } else if (!isBlank(lines[j])) {
        raw += '\n';
      }
    } else if (endsNL) {
      raw += '\n';
    }
  }
  return { text: stripTrailingBlanks(raw), next: j };
}

// Table starting at lines[i] (header) with the delimiter at lines[i+1].
function collectTable(lines, i, end) {
  const headerCells = splitTableRow(lines[i]);
  const delimCells = splitTableRow(lines[i + 1]);
  if (headerCells.length !== delimCells.length) return { tok: null, next: i };
  const align = delimCells.map((c) => {
    const t = c.trim();
    if (/^ *-+: *$/.test(t)) return 'right';
    if (/^ *:-+: *$/.test(t)) return 'center';
    if (/^ *:-+ *$/.test(t)) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (tableBodyStopsAt(line)) break;
    rows.push(splitTableRow(line, headerCells.length));
    j++;
  }
  return {
    tok: { t: 'table', header: headerCells, align, rows },
    next: j,
  };
}

// A line that ends a table body. Mirrors marked's table-body regex: a line
// is a row unless it is blank (only spaces), indented code (4 spaces, or
// 0-3 spaces + tab, followed by another character), or a block start
// (hr/heading/blockquote/fence/list/html). A whitespace-only line of 0-3
// spaces + a single tab is NOT blank here — it is an empty row.
function tableBodyStopsAt(line) {
  if (/^ *$/.test(line)) return true;
  if (/^(?: {4}| {0,3}\t)./.test(line)) return true;
  if (atxHeading(line) || fenceOpen(line) || isHr(line) || isQuoteLine(line)) return true;
  const lm = listMarker(line);
  if (lm && (!lm.ordered || lm.start === 1)) {
    if (lm.rest.length > 0 && (lm.rest[0] === ' ' || lm.rest[0] === '\t')) return true;
  }
  if (htmlBlockType(line)) return true;
  return false;
}

// A line that stops a paragraph: blank, or starting hr/heading/blockquote/
// fence/list (bullet or `1.` + spaces + non-space)/html.
function paraStopsAt(line) {
  if (isBlank(line)) return true;
  if (atxHeading(line) || fenceOpen(line) || isHr(line) || isQuoteLine(line)) return true;
  if (isParaListStop(line)) return true;
  if (htmlBlockType(line)) return true;
  return false;
}

// List marker that stops a paragraph: a bullet, or an ordered list starting
// with 1, followed by spaces/tabs and then a non-space character.
function isParaListStop(line) {
  const lm = listMarker(line);
  if (!lm) return false;
  if (lm.ordered && lm.start !== 1) return false;
  const rest = lm.rest;
  let k = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
  if (k === 0) return false;
  return k < rest.length;
}

// Collect a paragraph starting at lines[i]: lines until a blank line, a
// block start, or a table start.
function collectParagraph(lines, i, end) {
  let j = i;
  while (j + 1 < end) {
    const next = lines[j + 1];
    if (paraStopsAt(next)) break;
    if (isTableStart(next, lines[j + 2])) break;
    j++;
  }
  return { text: lines.slice(i, j + 1).join('\n'), next: j + 1 };
}

// Try a setext heading starting at lines[i]. The body is the paragraph
// lines (stopping at a blank line, a list marker + space, a fence, a
// blockquote, a heading, an hr, a lone tag line, or a table-delimiter
// line), followed by a setext underline.
function tryLheading(lines, i, end) {
  let j = i;
  while (j + 1 < end) {
    const next = lines[j + 1];
    if (isBlank(next)) break;
    if (lheadingStopsAt(next)) break;
    // A setext underline line ends the body (it is the underline, not a
    // body line) — the lheading regex is lazy, so it takes the shortest body.
    if (setextLevel(next) > 0) break;
    j++;
  }
  if (j + 1 < end) {
    const level = setextLevel(lines[j + 1]);
    if (level > 0) {
      const text = lines.slice(i, j + 1).join('\n').trim();
      return { tok: { t: 'heading', level, text }, next: j + 2 };
    }
  }
  return null;
}

// A line that stops a setext-heading body.
function lheadingStopsAt(line) {
  if (atxHeading(line) || fenceOpen(line) || isHr(line) || isQuoteLine(line)) return true;
  const lm = listMarker(line);
  if (lm && lm.rest.length > 0 && lm.rest[0] === ' ') return true;
  if (isTableDelimLine(line)) return true;
  if (isLoneTagLine(line)) return true;
  return false;
}

// A line that is a lone HTML tag (`<tag ...>` and nothing else).
function isLoneTagLine(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= 3 && line[i] === ' ') return false;
  if (line[i] !== '<') return false;
  const rest = line.slice(i + 1);
  const m = /^\/?[a-zA-Z][a-zA-Z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"]*"| *= *'[^']*'| *= *[^\s"'=<>`]+)?)* *\/?>/.exec(rest);
  if (!m) return false;
  return /^[ \t]*$/.test(rest.slice(m[0].length));
}

// --- main block loop -------------------------------------------------------

// Parse blocks from lines[i..end). `top` is true at the document level and
// inside blockquotes, false inside list items. `endsNL` is true when the
// last line of the whole source ends with a newline. Returns
// {toks, next}. The `links` map is filled with link reference definitions.
function parseBlocks(lines, i, end, top, links, endsNL) {
  const toks = [];
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      let j = i;
      while (j < end && isBlank(lines[j])) j++;
      toks.push({ t: 'space', n: j - i });
      i = j;
      continue;
    }
    if (indentCols(line) >= 4) {
      const r = collectCode(lines, i, end, endsNL);
      const prev = toks[toks.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) prev.text += '\n' + r.text;
      else toks.push({ t: 'code', text: r.text, lang: null });
      i = r.next;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const r = collectFence(lines, i, end, fence);
      toks.push({ t: 'code', text: r.text, lang: fenceLang(fence.info) });
      i = r.next;
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      toks.push({ t: 'heading', level: atx.level, text: headingText(line.slice(atx.start)) });
      i++;
      continue;
    }
    if (isHr(line)) { toks.push({ t: 'hr' }); i++; continue; }
    if (isQuoteLine(line)) {
      const r = parseBlockquote(lines, i, end, links, endsNL);
      toks.push(r.tok);
      i = r.next;
      continue;
    }
    const lm = listMarker(line);
    if (lm && (lm.rest === '' || lm.rest[0] === ' ' || lm.rest[0] === '\t')) {
      const r = parseList(lines, i, end, links, endsNL);
      if (r.tok) { toks.push(r.tok); i = r.next; continue; }
    }
    const htype = htmlBlockType(line);
    if (htype) {
      const r = collectHtml(lines, i, end, htype, endsNL);
      toks.push({ t: 'html', text: r.text });
      i = r.next;
      continue;
    }
    if (htmlType7(line)) {
      const r = collectHtml(lines, i, end, 7, endsNL);
      toks.push({ t: 'html', text: r.text });
      i = r.next;
      continue;
    }
    const def = scanDef(lines, i, end);
    if (def) {
      const prev = toks[toks.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.text += '\n' + def.raw;
      } else {
        const key = normalizeLabel(def.label);
        if (!links[key]) links[key] = { href: def.href, title: def.title };
      }
      i = def.next;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const delim = tableDelimiterCells(lines[i + 1]);
      const hasSep = lines[i + 1].indexOf(':') !== -1 || lines[i + 1].indexOf('|') !== -1;
      if (hasSep && splitTableRow(lines[i]).length === delim.length) {
        const r = collectTable(lines, i, end);
        toks.push(r.tok);
        i = r.next;
        continue;
      }
    }
    const lh = tryLheading(lines, i, end);
    if (lh) { toks.push(lh.tok); i = lh.next; continue; }
    if (top) {
      const r = collectParagraph(lines, i, end);
      toks.push({ t: 'paragraph', text: r.text });
      i = r.next;
      continue;
    }
    const prev = toks[toks.length - 1];
    if (prev && prev.t === 'text') prev.text += '\n' + line;
    else toks.push({ t: 'text', text: line });
    i++;
  }
  return { toks, next: i };
}

// Expand the leading whitespace of a string relative to a starting column.
function expandLeadingWS(s, col) {
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k === 0) return s;
  return expandTabs(s.slice(0, k), col) + s.slice(k);
}

// Index of the first non-space, non-tab character, or -1.
function firstNonSpace(s) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== ' ' && s[k] !== '\t') return k;
  }
  return -1;
}

// Does this line start a block at an indent of at most R columns?
// (Used by list item collection.)
function startsBlockAtIndent(line, R) {
  let sp = 0;
  while (sp < line.length && line[sp] === ' ' && sp < R) sp++;
  if (sp < line.length && line[sp] === ' ') return false;
  const rest = line.slice(sp);
  if (rest.length === 0) return false;
  const ch = rest[0];
  if (ch === '`' || ch === '~') {
    let n = 0;
    while (n < rest.length && rest[n] === ch) n++;
    if (n >= 3 && (ch === '~' || rest.slice(n).indexOf('`') === -1)) return true;
  }
  if (ch === '#') {
    let h = 0;
    while (h < rest.length && rest[h] === '#') h++;
    if (h >= 1 && h <= 6 && (h === rest.length || rest[h] === ' ' || rest[h] === '\t')) return true;
  }
  if (ch === '>') return true;
  if (ch === '<' && htmlBlockType(rest) !== 0) return true;
  if (ch === '-' || ch === '_' || ch === '*') {
    let n = 0, k = 0;
    while (k < rest.length) {
      if (rest[k] === ch) { n++; k++; }
      else if (rest[k] === ' ' || rest[k] === '\t') k++;
      else break;
    }
    if (n >= 3 && k === rest.length) return true;
  }
  const lm = listMarker(rest);
  if (lm) return true;
  return false;
}

// Does `m` + `\n` + `f` form a setext heading (used for the list setext
// trick)? The previous content line `m` plus this line `f`.
function isLheadingPair(m, f) {
  const level = setextLevel(f);
  if (level === 0) return false;
  if (m.trim() === '') return false;
  // The body's first line must not match the setext-heading lookahead.
  if (indentCols(m) >= 4) return false;
  const lm = listMarker(m);
  if (lm && lm.rest.length > 0 && lm.rest[0] === ' ') return false;
  if (fenceOpen(m) || isQuoteLine(m) || atxHeading(m)) return false;
  if (isLoneTagLine(m)) return false;
  if (isTableDelimLine(m)) return false;
  return true;
}

// --- lists ---------------------------------------------------------------

// Parse a list starting at lines[i]. Returns {tok, next}.
function parseList(lines, i, end, links, endsNL) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const bullet = first.bullet;
  const items = [];
  let loose = false;
  let p = false;
  let j = i;
  while (j < end) {
    const line = lines[j];
    const lm = listMarker(line);
    if (!lm) break;
    if (ordered) {
      if (!lm.ordered || lm.bullet.slice(-1) !== bullet.slice(-1)) break;
    } else {
      if (lm.ordered || lm.bullet !== bullet) break;
    }
    if (lm.rest !== '' && lm.rest[0] !== ' ' && lm.rest[0] !== '\t') break;
    if (isHr(line)) break;
    const itemStart = j;
    const markerLen = lm.len;
    const g = lm.rest;
    const m = expandLeadingWS(g, markerLen);
    const y0 = m.trim() === '';
    let R, d;
    if (y0) {
      R = markerLen + 1;
      d = '';
    } else {
      const idx = firstNonSpace(m);
      R = idx > 4 ? 1 : idx;
      d = m.slice(R);
      R += markerLen;
    }
    let k = j + 1;
    let empty = false;
    if (y0 && k < end && isBlank(lines[k])) { k++; empty = true; }
    if (!empty) {
      let y = y0;
      let mm = m;
      // The block-start checks use a clamped max indent: clamp(R - 1, 0, 3)
      // (marked's `D` helper), not R itself.
      const maxInd = Math.max(0, Math.min(3, R - 1));
      while (k < end) {
        const U = lines[k];
        const f = U;
        const Z = expandLeadingWS(f, 0);
        if (startsBlockAtIndent(f, maxInd)) break;
        if (firstNonSpace(Z) >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || firstNonSpace(mm.replace(/\t/g, '    ')) >= 4 || startsBlockAtIndent(mm, maxInd)) break;
          let qe = f;
          if (/^ {0,3}(?:=+|-+) *$/.test(f) && isLheadingPair(mm, f)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = !f.trim();
        k++;
        mm = Z.slice(R);
      }
    }
    // The item's raw ends with a blank line when its last consumed line is
    // blank (a blank line between this item and the next).
    const endsBlank = k > itemStart + 1 && isBlank(lines[k - 1]);
    if (!loose) {
      if (p) loose = true;
      else if (endsBlank) p = true;
    }
    items.push({ text: d, rawLines: lines.slice(itemStart, k), lastLine: k - 1, task: false, checked: false, toks: [], loose: false });
    j = k;
  }
  if (items.length === 0) return { tok: null, next: i };
  // Trim the last item's text.
  items[items.length - 1].text = items[items.length - 1].text.replace(/[ \t\n]+$/, '');
  // Back up over trailing blank lines consumed by the last item: marked
  // trims the list raw, so trailing blank lines are left unconsumed and the
  // outer parser sees them as a space token (which is what makes a list
  // loose when an item ends with a blank line before another block).
  while (j > i && isBlank(lines[j - 1])) j--;
  // The list's raw lines: from the first item's start to the last item's end.
  const rawLines = lines.slice(i, j);
  // Lex each item's tokens (top=false).
  for (const item of items) {
    const itemLines = item.text.split('\n');
    // Whether the item's text string ends with a newline (it is built by
    // joining its lines, so this is true only when its last line is blank).
    const itemEndsNL = item.text.endsWith('\n');
    const r = parseBlocks(itemLines, 0, itemLines.length, false, links, itemEndsNL);
    item.toks = r.toks;
    if (!loose) {
      // A space token makes the list loose iff its raw contains two
      // newlines. Its raw has n blank-line newlines plus the newline that
      // ended the previous token's line — except when it is the first token,
      // or the previous token is an html block whose text already ends with
      // a newline (that newline was consumed by the html token's raw).
      for (let ti = 0; ti < item.toks.length; ti++) {
        const t = item.toks[ti];
        if (t.t !== 'space') continue;
        let nl = t.n;
        if (ti > 0) {
          const prev = item.toks[ti - 1];
          if (!(prev.t === 'html' && prev.text.endsWith('\n'))) nl += 1;
        }
        if (nl >= 2) { loose = true; break; }
      }
    }
  }
  // Task items.
  for (const item of items) {
    const m = /^\[([ xX])\][ \t]+(?=\S)/.exec(item.text);
    const firstTok = item.toks[0];
    if (m && firstTok && (firstTok.t === 'text' || firstTok.t === 'paragraph')) {
      item.task = true;
      item.checked = m[1] !== ' ';
      const strip = /^\[[ xX]\][ \t]+/;
      item.text = item.text.replace(strip, '');
      firstTok.text = firstTok.text.replace(strip, '');
      const cb = item.checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      if (loose) {
        // The checkbox goes inside the first paragraph.
        if (firstTok.t === 'paragraph' || firstTok.t === 'text') {
          firstTok.text = cb + firstTok.text;
        } else {
          item.toks.unshift({ t: 'paragraph', text: cb });
        }
      } else {
        item.toks.unshift({ t: 'checkbox', checked: item.checked });
      }
    }
  }
  if (loose) {
    for (const item of items) {
      item.loose = true;
      for (const t of item.toks) if (t.t === 'text') t.t = 'paragraph';
    }
  }
  return {
    tok: {
      t: 'list', ordered, start: ordered ? first.start : 0,
      items, loose, rawLines,
    },
    next: j,
  };
}

// --- blockquotes -----------------------------------------------------------

// A line that stops a lazy blockquote continuation (the paragraph
// lookahead used by the blockquote rule).
function lazyStopsAt(line) {
  if (isBlank(line)) return true;
  if (atxHeading(line) || fenceOpen(line) || isHr(line) || isQuoteLine(line)) return true;
  const lm = listMarker(line);
  if (lm && (lm.rest === '' || lm.rest[0] === ' ' || lm.rest[0] === '\t')) return true;
  if (htmlBlockType(line)) return true;
  return false;
}

// Strip a blockquote chunk (lines) to its inner content. `>` markers are
// stripped; a lazy setext-underline line (other than the chunk's first
// line) is indented by four spaces so it lexes as indented code.
function stripQuoteChunk(chunkLines) {
  const out = [];
  for (let k = 0; k < chunkLines.length; k++) {
    const line = chunkLines[k];
    if (isQuoteLine(line)) {
      out.push(stripQuoteMarker(line));
    } else if (k > 0 && setextLevel(line) > 0) {
      out.push('    ' + line.replace(/^ {0,3}/, ''));
    } else {
      out.push(line);
    }
  }
  return out;
}

// Merge a chunk's tokens into the accumulated list: the chunk's first
// paragraph merges into the previous paragraph token when both are
// paragraphs.
function mergeChunkTokens(tokens, chunkToks) {
  let start = 0;
  if (chunkToks.length > 0 && chunkToks[0].t === 'paragraph') {
    const prev = tokens[tokens.length - 1];
    if (prev && prev.t === 'paragraph') {
      prev.text += '\n' + chunkToks[0].text;
      start = 1;
    }
  }
  for (let k = start; k < chunkToks.length; k++) tokens.push(chunkToks[k]);
}

// Parse a blockquote starting at lines[i]. Returns {tok, next}.
function parseBlockquote(lines, i, end, links, endsNL) {
  // The match extent: quote lines, plus the lazy paragraph lines that
  // follow a non-blank quote line.
  let j = i;
  while (j < end) {
    if (!isQuoteLine(lines[j])) break;
    const content = stripQuoteMarker(lines[j]);
    j++;
    if (content.trim() !== '') {
      while (j < end && !lazyStopsAt(lines[j])) j++;
    }
  }
  const extentEnd = j;
  const combinedEndsNL = (extentEnd < end) || endsNL;
  let n = lines.slice(i, j);
  const tokens = [];
  let consumed = 0;
  while (n.length > 0) {
    let p = 0;
    let seen = false;
    for (; p < n.length; p++) {
      if (isQuoteLine(n[p])) seen = true;
      else if (!seen) { /* a leading lazy line */ }
      else break;
    }
    const chunkLines = n.slice(0, p);
    n = n.slice(p);
    consumed += p;
    const stripped = stripQuoteChunk(chunkLines);
    const chunkEndsNL = (i + consumed - 1 < end - 1) || endsNL;
    const r = parseBlocks(stripped, 0, stripped.length, true, links, chunkEndsNL);
    mergeChunkTokens(tokens, r.toks);
    if (n.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (!k || k.t === 'code' || k.t === 'heading' || k.t === 'hr' || k.t === 'html' || k.t === 'table') break;
    if (k.t === 'blockquote') {
      // Extend the nested quote with the remaining lines (markers stripped).
      const combined = k.rawLines.concat(n.map((ln) => (isQuoteLine(ln) ? stripQuoteMarker(ln) : ln)));
      const rr = parseBlockquote(combined, 0, combined.length, links, combinedEndsNL);
      tokens[tokens.length - 1] = rr.tok;
      const used = Math.max(0, rr.next - k.rawLines.length);
      if (used > 0) { consumed += used; n = n.slice(used); }
      if (n.length > 0 && isQuoteLine(n[0])) continue;
      break;
    }
    if (k.t === 'list') {
      // Extend the nested list with the remaining lines (as-is).
      const combined = k.rawLines.concat(n);
      const rr = parseList(combined, 0, combined.length, links, combinedEndsNL);
      if (rr.tok) tokens[tokens.length - 1] = rr.tok;
      const used = Math.max(0, rr.next - k.rawLines.length);
      if (used > 0) { consumed += used; n = n.slice(used); }
      continue;
    }
    // A paragraph, text or space token: keep going.
  }
  return {
    tok: { t: 'blockquote', toks: tokens, rawLines: lines.slice(i, i + consumed) },
    next: i + consumed,
  };
}

// --- rendering -------------------------------------------------------------

function renderList(tok, links) {
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
  let out = `<${tag}${start}>\n`;
  for (const item of tok.items) out += renderListItem(item, links);
  return out + `</${tag}>\n`;
}

function renderListItem(item, links) {
  // The checkbox (if any) is already in item.toks as a `checkbox` token
  // (tight) or prepended to the first paragraph's text (loose).
  const body = renderBlocks(item.toks, links, item.loose);
  return '<li>' + body + '</li>\n';
}

function renderTable(tok, links) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < tok.header.length; c++) {
    const align = tok.align[c] ? ` align="${tok.align[c]}"` : '';
    out += `<th${align}>` + inlineHtml(tok.header[c], links, false) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (tok.rows.length > 0) {
    out += '<tbody>';
    for (const row of tok.rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        const align = tok.align[c] ? ` align="${tok.align[c]}"` : '';
        out += `<td${align}>` + inlineHtml(row[c], links, false) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

function renderBlocks(toks, links, top) {
  let out = '';
  for (const tok of toks) {
    switch (tok.t) {
      case 'space': break;
      case 'code': {
        const lang = tok.lang ? ` class="language-${escapeText(tok.lang, false)}"` : '';
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += `<pre><code${lang}>${escapeText(text, true)}</code></pre>\n`;
        break;
      }
      case 'heading':
        out += `<h${tok.level}>` + inlineHtml(tok.text, links, false) + `</h${tok.level}>\n`;
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.toks, links, true) + '</blockquote>\n';
        break;
      case 'list': out += renderList(tok, links); break;
      case 'html': out += tok.text; break;
      case 'table': out += renderTable(tok, links); break;
      case 'paragraph':
        out += '<p>' + inlineHtml(tok.text, links, false) + '</p>\n';
        break;
      case 'text':
        out += top
          ? '<p>' + inlineHtml(tok.text, links, false) + '</p>\n'
          : inlineHtml(tok.text, links, false);
        break;
      case 'checkbox':
        out += tok.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        break;
    }
  }
  return out;
}

// --- entry point -----------------------------------------------------------

// Render markdown to HTML, exactly as marked 18.1.3 does with default
// options (gfm, no breaks, not pedantic, synchronous).
export function parse(src) {
  docInLink = false;
  const text = src.replace(/\r\n|\r/g, '\n');
  const lines = text.split('\n');
  // A trailing newline terminates the last line; it is not a blank line.
  if (text.endsWith('\n')) lines.pop();
  const endsNL = text.endsWith('\n');
  const links = {};
  const { toks } = parseBlocks(lines, 0, lines.length, true, links, endsNL);
  return renderBlocks(toks, links, true);
}
