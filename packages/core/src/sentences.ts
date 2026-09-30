const ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e|Fig|No|Inc|Ltd|Co|Mt|approx|cf)\.\s*$/;
const INITIAL = /(?:^|\s)[A-Z]\.\s*$/;

function regexSplit(text: string): string[] {
  const m = text.match(/[^.!?]+[.!?]+["”’')\]]*\s*|[^.!?]+$/g);
  return m ? m.map((s) => s.trim()).filter(Boolean) : [text.trim()].filter(Boolean);
}

export function splitSentences(text: string, lang = 'en'): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  let raw: string[];
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    raw = Array.from(new Seg(lang, { granularity: 'sentence' }).segment(clean), (s) => s.segment.trim()).filter(Boolean);
  } else {
    raw = regexSplit(clean);
  }
  const merged: string[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (ABBREV.test(prev) || INITIAL.test(prev))) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  return merged;
}

/** Splits very long sentences at clause boundaries so voices never receive huge inputs. */
export function wrapLong(sentence: string, max = 280): string[] {
  if (sentence.length <= max) return [sentence];
  const parts = sentence.replace(/([,;:])\s+/g, '$1\u0000').split('\u0000');
  const tokens: string[] = [];
  for (const p of parts) {
    if (p.length <= max) {
      tokens.push(p);
      continue;
    }
    let buf = '';
    for (const w of p.split(/\s+/)) {
      if (buf && buf.length + 1 + w.length > max) {
        tokens.push(buf);
        buf = w;
      } else buf = buf ? `${buf} ${w}` : w;
    }
    if (buf) tokens.push(buf);
  }
  const out: string[] = [];
  let cur = '';
  for (const t of tokens) {
    if (cur && cur.length + 1 + t.length > max) {
      out.push(cur);
      cur = t;
    } else cur = cur ? `${cur} ${t}` : t;
  }
  if (cur) out.push(cur);
  return out;
}
