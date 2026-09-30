import { useRef, useState } from 'react';
import { FileUp, Link2, ClipboardPaste, X } from 'lucide-react';
import { analyze, DEFAULT_CLEANUP } from '@wells/core';
import type { CleanupOptions, CleanupReport, ReadingMode } from '@wells/core';
import { checkUsage } from '@wells/billing/src/plans.ts';
import { db } from '../db';
import { ACCEPT, ImportError, importFile, importPaste, importUrl } from '../importers';
import { saveImport, type Imported } from '../pipeline';
import { MODE_LABELS, useHasFeature, usePlan, useSetting } from '../hooks';
import { CleanupPanel } from './CleanupPanel';
import { Sheet } from './Sheet';
import { ocrUsed } from '../importers/ocr';
import { useLiveQuery } from 'dexie-react-hooks';

type Tab = 'file' | 'paste' | 'link';

export function ImportSheet({ onClose, onDone, defaultWellId }: { onClose: () => void; onDone: (docId: string) => void; defaultWellId?: string }) {
  const plan = usePlan();
  const canBatch = useHasFeature('batch_processing');
  const canOcr = useHasFeature('ocr');
  const [defaultMode] = useSetting<ReadingMode>('defaultMode', 'clean');
  const wells = useLiveQuery(() => db.wells.filter((w) => w.kind !== 'smart').toArray(), [], []);
  const [tab, setTab] = useState<Tab>('file');
  const [stage, setStage] = useState<string | null>(null);
  const [imp, setImp] = useState<Imported | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [cleanup, setCleanup] = useState<CleanupOptions>({ ...DEFAULT_CLEANUP });
  const [mode, setMode] = useState<ReadingMode | null>(null);
  const [wellId, setWellId] = useState(defaultWellId ?? '');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const cancelled = useRef(false);
  const lastAction = useRef<(() => Promise<void>) | null>(null);

  const ready = (r: Imported) => {
    setImp(r); setReport(analyze(r.pages)); setTitle(r.meta.title ?? ''); setCleanup({ ...DEFAULT_CLEANUP }); setStage(null);
  };
  const guard = async (fn: () => Promise<void>) => {
    lastAction.current = fn;
    cancelled.current = false; setError(null);
    const used = await db.docs.count();
    if (!checkUsage(plan, 'documents', used).allowed) {
      setError(`Your ${plan} plan holds ${checkUsage(plan, 'documents', used).limit} documents. Delete one, or upgrade to add more.`);
      return;
    }
    try { await fn(); }
    catch (e) { setStage(null); setError(e instanceof ImportError || e instanceof Error ? e.message : 'We could not read that. Try another file.'); }
  };

  const onFiles = (files: FileList | File[]) => guard(async () => {
    const list = Array.from(files);
    if (!list.length) return;
    if (list.length > 1 && !canBatch) setError('Your plan imports one file at a time, so only the first file was used.');
    setStage('Reading file…');
    const left = checkUsage(plan, 'ocr_pages', await ocrUsed()).remaining;
    const r = await importFile(list[0], (d, t) => setStage(`Reading page ${d} of ${t}…`), { ocr: canOcr, ocrPagesLeft: left });
    if (!cancelled.current) ready(r);
  });
  const onPaste = () => guard(async () => { ready(importPaste(text, title || undefined)); });
  const onLink = () => guard(async () => { setStage('Fetching page…'); const r = await importUrl(url.trim()); if (!cancelled.current) ready(r); });

  const finish = async () => {
    if (!imp) return;
    setStage('Structuring…');
    try {
      const id = await saveImport({ ...imp, meta: { ...imp.meta, title: title.trim() || imp.meta.title } }, cleanup, mode ?? defaultMode, wellId || undefined);
      void navigator.storage?.persist?.();
      onDone(id);
    } catch (e) { setStage(null); setError(e instanceof Error ? e.message : 'We could not save this document. Try again.'); }
  };

  return (
    <Sheet onClose={onClose} label="Add to library" className="import-sheet">
        <header className="sheet-head">
          <h2>{imp ? 'Review before adding' : 'Add to library'}</h2>
          <button className="icon-btn" onClick={() => { cancelled.current = true; onClose(); }} aria-label="Close"><X size={22} /></button>
        </header>

        {!imp && (
          <>
            <div className="tabs" role="tablist">
              {([['file', FileUp, 'File'], ['paste', ClipboardPaste, 'Paste text'], ['link', Link2, 'Link']] as const).map(([k, Icon, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => { setTab(k); setError(null); }}><Icon size={18} /> {label}</button>
              ))}
            </div>

            {tab === 'file' && (
              <label className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); void onFiles(e.dataTransfer.files); }}>
                <FileUp size={28} aria-hidden />
                <strong>Choose a file or drop it here</strong>
                <span>PDF, EPUB, Word, Markdown, text or HTML</span>
                <input type="file" accept={ACCEPT} multiple onChange={(e) => e.target.files && void onFiles(e.target.files)} />
              </label>
            )}
            {tab === 'paste' && (
              <div className="stack">
                <input className="text-input" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
                <textarea className="text-input" rows={8} placeholder="Paste text or an article here" value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to import" />
                <button className="btn primary" disabled={!text.trim()} onClick={() => void onPaste()}>Continue</button>
              </div>
            )}
            {tab === 'link' && (
              <div className="stack">
                <input className="text-input" type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Web address" />
                <button className="btn primary" disabled={!url.trim()} onClick={() => void onLink()}>Continue</button>
              </div>
            )}
            {stage && <p className="status" role="status">{stage}</p>}
          </>
        )}

        {imp && report && (
          <div className="stack">
            <label className="field">Title
              <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <CleanupPanel report={report} options={cleanup} onChange={setCleanup} />
            <label className="field">Reading mode
              <select value={mode ?? defaultMode} onChange={(e) => setMode(e.target.value as ReadingMode)}>
                {(Object.keys(MODE_LABELS) as ReadingMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m].name}</option>)}
              </select>
              <span className="hint">{MODE_LABELS[mode ?? defaultMode].blurb}</span>
            </label>
            <label className="field">Add to well
              <select value={wellId} onChange={(e) => setWellId(e.target.value)}>
                <option value="">None</option>
                {wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <div className="row-end">
              <button className="btn" onClick={() => { setImp(null); setReport(null); }}>Back</button>
              <button className="btn primary" disabled={!!stage} onClick={() => void finish()}>{stage ?? 'Add to library'}</button>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="error-box">
            <p>{error}</p>
            {lastAction.current && !imp && <button className="btn" onClick={() => void guard(lastAction.current!)}>Try again</button>}
          </div>
        )}
    </Sheet>
  );
}
