import type { DocBlock, DocSection, ParsedDocument, SourceType } from './model.ts';

const CHAPTER_RE = /^(?:(?:chapter|part|book|section|appendix)\s+(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[.:]?(?:\s+\S.{0,60})?|(?:prologue|epilogue|preface|introduction|conclusion|abstract))$/i;
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+){0,3})\s+[A-Z][^.!?]{2,60}$/;

export interface HeadingGuess {
  level: number;
  text: string;
}

/** Single-line heading detection for plain text and PDF-extracted text. */
export function guessHeading(line: string): HeadingGuess | null {
  const t = line.trim();
  if (!t || t.length > 80 || t.includes('\n')) return null;
  const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(t);
  if (md) return { level: md[1].length, text: md[2] };
  if (
    CHAPTER_RE.test(t) &&
    t.split(/\s+/).length <= 9 &&
    !/[!?]$/.test(t) &&
    (!/\.$/.test(t) || /^\w+\s+\S+\.$/.test(t))
  ) {
    const word = t.split(/\s+/)[0].toLowerCase();
    const major = ['chapter', 'part', 'book', 'prologue', 'epilogue', 'preface'].includes(word);
    return { level: major ? 1 : 2, text: t };
  }
  const num = NUMBERED_HEADING_RE.exec(t);
  if (num) return { level: Math.min(4, num[1].split('.').length + 1), text: t };
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 5 && t === t.toUpperCase() && t.length <= 60 && !/[.!?,;]$/.test(t)) {
    return { level: 2, text: t };
  }
  return null;
}

export function isHeadingLine(line: string): boolean {
  return guessHeading(line) !== null;
}

export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

function parseTableRow(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

export interface ParseMeta {
  title?: string;
  author?: string;
  sourceType: SourceType;
  language?: string;
  pageCount?: number;
}

/**
 * Turns normalized text (paragraphs separated by blank lines) into typed blocks and sections.
 * Handles markdown headings, setext headings, plain-text chapter headings, lists, quotes,
 * markdown tables and figure/table captions.
 */
export function parseStructure(text: string, meta: ParseMeta): ParsedDocument {
  const chunks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
  const blocks: DocBlock[] = [];
  let tableRows: string[][] | null = null;

  const push = (b: Omit<DocBlock, 'id'>) => {
    blocks.push({ id: `b${pad(blocks.length + 1)}`, ...b });
  };
  const flushTable = () => {
    if (tableRows && tableRows.length) {
      push({ type: 'table', text: tableRows.map((r) => r.join(', ')).join('. '), rows: tableRows });
    }
    tableRows = null;
  };

  for (const chunk of chunks) {
    const lines = chunk.split('\n');

    if (/^\|/.test(lines[0])) {
      tableRows = tableRows ?? [];
      for (const l of lines) {
        if (/^\|/.test(l.trim()) && !isSeparatorRow(l)) tableRows.push(parseTableRow(l.trim()));
      }
      continue;
    }
    flushTable();

    if (lines.length === 2 && /^(=+|-+)$/.test(lines[1].trim()) && lines[0].trim().length > 0) {
      push({ type: 'heading', level: lines[1].trim()[0] === '=' ? 1 : 2, text: lines[0].trim() });
      continue;
    }

    const single = lines.length === 1 ? guessHeading(chunk) : null;
    if (single) {
      push({ type: 'heading', level: single.level, text: single.text });
      continue;
    }

    if (/^>\s?/.test(chunk)) {
      push({ type: 'quote', text: lines.map((l) => l.replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim() });
      continue;
    }

    const li = /^([-*+]|\d+[.)])\s+([\s\S]*)$/.exec(chunk);
    if (li) {
      push({ type: 'list_item', ordered: /\d/.test(li[1]), text: li[2].replace(/\s+/g, ' ').trim() });
      continue;
    }

    if (/^(table|figure|fig\.)\s+\d+/i.test(chunk) && chunk.length < 300) {
      push({ type: 'caption', text: chunk.replace(/\s+/g, ' ') });
      continue;
    }

    push({ type: 'paragraph', text: chunk.replace(/\s+/g, ' ') });
  }
  flushTable();

  const firstH1 = blocks.find((b) => b.type === 'heading' && b.level === 1);
  const firstLine = blocks.find((b) => b.type === 'paragraph' || b.type === 'heading');
  const title = (meta.title?.trim() || firstH1?.text || firstLine?.text.slice(0, 80) || 'Untitled').trim();

  const sections: DocSection[] = [];
  let current: DocSection = { id: 's0000', title, level: 0, blockIds: [] };
  sections.push(current);
  for (const b of blocks) {
    if (b.type === 'heading') {
      // A heading directly after the implicit intro (nothing before it) replaces it.
      if (current.blockIds.length === 0 && current.id === 's0000' && sections.length === 1) {
        sections.pop();
      }
      current = { id: `s${pad(sections.length)}`, title: b.text, level: b.level ?? 2, blockIds: [] };
      sections.push(current);
    }
    current.blockIds.push(b.id);
  }

  const wordCount = blocks
    .filter((b) => ['heading', 'paragraph', 'list_item', 'quote'].includes(b.type))
    .reduce((n, b) => n + countWords(b.text), 0);

  return {
    title,
    author: meta.author,
    sourceType: meta.sourceType,
    language: meta.language,
    blocks,
    sections,
    wordCount,
    pageCount: meta.pageCount,
  };
}
