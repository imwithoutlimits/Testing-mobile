export type SourceType = 'pdf' | 'epub' | 'md' | 'txt' | 'docx' | 'html' | 'image' | 'url' | 'paste';

export type BlockType =
  | 'heading' | 'paragraph' | 'list_item' | 'quote' | 'table'
  | 'figure' | 'caption' | 'footnote' | 'code';

export interface DocBlock {
  id: string;
  type: BlockType;
  text: string;
  level?: number;
  ordered?: boolean;
  page?: number;
  rows?: string[][];
}

export interface DocSection {
  id: string;
  title: string;
  level: number;
  blockIds: string[];
}

export interface CleanupReport {
  pageNumbers: number;
  repeatedHeaders: number;
  footnotes: number;
  references: number;
  citations: number;
  tables: number;
  figures: number;
  hyphenatedWords: number;
}

export interface ParsedDocument {
  title: string;
  author?: string;
  sourceType: SourceType;
  language?: string;
  blocks: DocBlock[];
  sections: DocSection[];
  wordCount: number;
  pageCount?: number;
  report?: CleanupReport;
}

export type ReadingMode = 'clean' | 'complete' | 'audiobook' | 'study' | 'accessibility';

export interface NarrationOptions {
  tables: 'skip' | 'announce' | 'read';
  readCaptions: boolean;
  readFootnotes: 'never' | 'inline';
  citations: 'skip' | 'author-year';
  headingPauseMs: number;
  sectionPauseMs: number;
  paragraphPauseMs: number;
  sentencePauseMs: number;
}

export interface Utterance {
  id: string;
  blockId: string;
  sectionId: string;
  kind: BlockType | 'announce';
  /** Text shown and highlighted in the reader. */
  text: string;
  /** Text sent to the voice (pronunciations and citation handling applied). */
  spoken: string;
  pauseAfterMs: number;
}

export interface PronunciationEntry {
  term: string;
  say: string;
}
