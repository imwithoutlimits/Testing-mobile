import type { NarrationOptions, ParsedDocument, PronunciationEntry, ReadingMode, Utterance } from './model.ts';
import { stripCitations, stripNumericCitations } from './cleanup.ts';
import { splitSentences, wrapLong } from './sentences.ts';

export const MODE_PRESETS: Record<ReadingMode, NarrationOptions> = {
  clean: { tables: 'announce', readCaptions: false, readFootnotes: 'never', citations: 'skip', headingPauseMs: 700, sectionPauseMs: 1100, paragraphPauseMs: 550, sentencePauseMs: 180 },
  complete: { tables: 'read', readCaptions: true, readFootnotes: 'inline', citations: 'author-year', headingPauseMs: 700, sectionPauseMs: 1100, paragraphPauseMs: 550, sentencePauseMs: 180 },
  audiobook: { tables: 'skip', readCaptions: false, readFootnotes: 'never', citations: 'skip', headingPauseMs: 900, sectionPauseMs: 1600, paragraphPauseMs: 650, sentencePauseMs: 120 },
  study: { tables: 'read', readCaptions: true, readFootnotes: 'never', citations: 'author-year', headingPauseMs: 800, sectionPauseMs: 1200, paragraphPauseMs: 700, sentencePauseMs: 220 },
  accessibility: { tables: 'announce', readCaptions: true, readFootnotes: 'never', citations: 'skip', headingPauseMs: 900, sectionPauseMs: 1400, paragraphPauseMs: 800, sentencePauseMs: 250 },
};

export function applyPronunciations(text: string, entries: PronunciationEntry[]): string {
  const sorted = entries.filter((e) => e.term.trim()).sort((a, b) => b.term.length - a.term.length);
  let out = text;
  for (const e of sorted) {
    const esc = e.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^\w/.test(e.term) ? '\\b' : '';
    const right = /\w$/.test(e.term) ? '\\b' : '';
    out = out.replace(new RegExp(left + esc + right, 'gi'), () => e.say);
  }
  return out;
}

export function buildUtterances(
  doc: ParsedDocument,
  opts: NarrationOptions,
  pronunciations: PronunciationEntry[] = [],
): Utterance[] {
  const out: Utterance[] = [];
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]));
  const lang = doc.language ?? 'en';

  const speak = (t: string) =>
    applyPronunciations(opts.citations === 'skip' ? stripCitations(t) : stripNumericCitations(t), pronunciations)
      .replace(/\s+/g, ' ')
      .trim();

  doc.sections.forEach((section) => {
    section.blockIds.forEach((bid, bi) => {
      const b = blocks.get(bid);
      if (!b) return;
      const made: Utterance[] = [];
      const add = (kind: Utterance['kind'], text: string, spoken: string, pause: number) => {
        if (!spoken) return;
        made.push({ id: `${b.id}.${made.length}`, blockId: b.id, sectionId: section.id, kind, text, spoken, pauseAfterMs: pause });
      };

      const readProse = (endPause: number) => {
        const sentences = splitSentences(b.text, lang).flatMap((s) => wrapLong(s));
        sentences.forEach((s) => add(b.type, s, speak(s), opts.sentencePauseMs));
        if (made.length) made[made.length - 1].pauseAfterMs = endPause;
      };

      switch (b.type) {
        case 'heading':
          add('heading', b.text, speak(b.text), opts.headingPauseMs);
          if (bi === 0 && out.length > 0) {
            const prev = out[out.length - 1];
            prev.pauseAfterMs = Math.max(prev.pauseAfterMs, opts.sectionPauseMs);
          }
          break;
        case 'paragraph':
        case 'quote':
          readProse(opts.paragraphPauseMs);
          break;
        case 'list_item':
          readProse(350);
          break;
        case 'table': {
          const rows = b.rows ?? [];
          if (opts.tables === 'skip') break;
          const n = `Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`;
          add('announce', n, n, 400);
          if (opts.tables === 'read') {
            rows.slice(0, 12).forEach((r, i) => {
              const line = `Row ${i + 1}: ${r.join(', ')}`;
              add('table', line, speak(line), 300);
            });
            if (rows.length > 12) add('announce', 'The table continues.', 'The table continues.', 400);
          }
          break;
        }
        case 'caption':
        case 'figure':
          if (opts.readCaptions) readProse(opts.paragraphPauseMs);
          break;
        case 'footnote':
          if (opts.readFootnotes === 'inline') readProse(opts.paragraphPauseMs);
          break;
        case 'code':
          break;
      }
      out.push(...made);
    });
  });
  return out;
}

export function estimateMinutes(words: number, rate = 1): number {
  return Math.max(1, Math.round(words / (160 * rate)));
}

export function scaledNarration(mode: ReadingMode, scale: number): NarrationOptions {
  const p = MODE_PRESETS[mode];
  return { ...p, headingPauseMs: p.headingPauseMs * scale, sectionPauseMs: p.sectionPauseMs * scale, paragraphPauseMs: p.paragraphPauseMs * scale, sentencePauseMs: p.sentencePauseMs * scale };
}
