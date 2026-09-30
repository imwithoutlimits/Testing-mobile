const SKIP = new Set(['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'ASIDE', 'NOSCRIPT', 'IFRAME', 'SVG', 'FORM', 'BUTTON']);

function inline(el: Node): string {
  let out = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element;
      if (SKIP.has(e.tagName.toUpperCase())) return;
      if (e.tagName === 'BR') { out += ' '; return; }
      if (e.tagName === 'SUP' && /^\s*[\[(]?\d{1,3}[\])]?\s*$/.test(e.textContent ?? '')) return; // footnote markers
      if (e.tagName === 'IMG') return;
      out += inline(e);
    }
  });
  return out;
}
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Converts an HTML element to paragraph-separated text with light markdown markers. */
export function htmlToText(root: Element): string {
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (/^H[1-6]$/.test(tag)) { const t = ws(inline(child)); if (t) out.push(`${'#'.repeat(Number(tag[1]))} ${t}`); }
      else if (tag === 'P' || tag === 'DIV' && !child.querySelector('p,div,ul,ol,table,h1,h2,h3,h4,h5,h6,blockquote')) { const t = ws(inline(child)); if (t) out.push(t); }
      else if (tag === 'UL' || tag === 'OL') {
        let n = 0;
        for (const li of Array.from(child.children)) {
          if (li.tagName !== 'LI') continue;
          n++;
          const t = ws(inline(li));
          if (t) out.push(tag === 'OL' ? `${n}. ${t}` : `- ${t}`);
        }
      } else if (tag === 'BLOCKQUOTE') { const t = ws(inline(child)); if (t) out.push(`> ${t}`); }
      else if (tag === 'TABLE') {
        const rows = Array.from(child.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => ws(inline(c)).replace(/\|/g, '/')));
        rows.filter((r) => r.length).forEach((r, i) => { out.push(`| ${r.join(' | ')} |`); if (i === 0) out.push(`|${r.map(() => '---').join('|')}|`); });
      } else if (tag === 'FIGURE') {
        const cap = child.querySelector('figcaption');
        if (cap) { const t = ws(inline(cap)); if (t) out.push(/^(figure|fig\.|table)\s+\d+/i.test(t) ? t : `Figure. ${t}`); }
      } else if (tag === 'PRE') { const t = ws(child.textContent ?? ''); if (t) out.push(t); }
      else walk(child);
    }
  };
  walk(root);
  return out.join('\n\n');
}

export function articleRoot(doc: Document): Element {
  return doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
}
