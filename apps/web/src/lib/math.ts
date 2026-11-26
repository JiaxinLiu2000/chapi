/**
 * Normalize LLM math output so remark-math + KaTeX can render it, without
 * turning currency into formulas.
 *
 * - `\[ … \]` → display math `$$ … $$`; `\( … \)` → inline math `$…$`
 *   (models emit both styles; remark-math only understands dollars).
 * - Single `$` pairs follow pandoc's rules: the opener must be followed by a
 *   non-space, the closer preceded by a non-space and NOT followed by a digit.
 *   Any `$` that does not form such a pair is escaped to `\$`, so
 *   "租金 $2,500 到 $3,000" / "$1.2M and $800K" / "$2,500-$3,000" stay text.
 * - Fenced code blocks and inline `code` spans are left untouched.
 */
export function prepareMath(src: string): string {
  if (!src.includes('$') && !src.includes('\\(') && !src.includes('\\[')) return src;
  // Split out fenced code blocks (``` or ~~~), keeping them verbatim.
  const parts = src.split(/(^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*(?:```|~~~)[ \t]*$|(?![\s\S])))/m);
  return parts.map((p, i) => (i % 2 === 1 ? p : prepareProse(p))).join('');
}

function prepareProse(text: string): string {
  // Split out inline code spans (`x`, ``x``), keeping them verbatim.
  const parts = text.split(/((`+)[\s\S]*?\2)/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    out.push(fixDollars(convertBrackets(parts[i] ?? '')));
    if (parts[i + 1] !== undefined) out.push(parts[i + 1]!);
  }
  return out.join('');
}

function convertBrackets(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function fixDollars(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      out += c + s[i + 1];
      i += 2;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    // Display math: copy `$$ … $$` through untouched (or the rest, while streaming).
    if (s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    const close = findInlineClose(s, i);
    if (close === -1) {
      out += '\\$';
      i++;
    } else {
      out += s.slice(i, close + 1);
      i = close + 1;
    }
  }
  return out;
}

/** Index of the closing `$` for an inline opener at `open`, or -1 (pandoc rules). */
function findInlineClose(s: string, open: number): number {
  if (isSpace(s[open + 1])) return -1;
  for (let j = open + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n' && s[j + 1] === '\n') return -1; // math never spans paragraphs
    if (c !== '$') continue;
    if (s[j + 1] === '$') return -1;
    if (!isSpace(s[j - 1]) && !/\d/.test(s[j + 1] ?? '')) return j;
    return -1; // first candidate closer is invalid → this `$` is literal
  }
  return -1;
}
