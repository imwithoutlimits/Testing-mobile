export class ImportError extends Error {}
export class NeedsOcrError extends ImportError {
  constructor() { super('This PDF looks like scanned images with no embedded text. Reading scanned pages needs OCR, which is included with Plus.'); }
}
