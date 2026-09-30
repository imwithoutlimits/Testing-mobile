import { useEffect, useRef, useState } from 'react';
import { Download, FileAudio, Lock, Play, Trash2 } from 'lucide-react';
import { hasFeature } from '@wells/billing/src/plans.ts';
import { apiBlob, ApiError } from '../supabase';
import { useUser } from '../auth';
import { usePlan, useSetting } from '../hooks';
import { downloadDocumentAudio, downloadStats, exportStatus, removeDownloads, startAudioExport, useCapabilities, useVoices as useServerVoices, type ExportStatus } from '../serverVoice';

export function NaturalVoice({ docId }: { docId?: string }) {
  const user = useUser();
  const plan = usePlan();
  const caps = useCapabilities(!!user);
  const [on, setOn] = useSetting('useServerVoice', false);
  const [provider, setProvider] = useSetting('ttsProvider', '');
  const [voice, setVoice] = useSetting('ttsVoice', '');
  const voices = useServerVoices(provider);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'download' | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stats, setStats] = useState<{ chunks: number; bytes: number } | null>(null);
  const cancel = useRef({ cancelled: false });
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { if (caps && caps.engines.length && !caps.engines.some((e) => e.id === provider)) setProvider(caps.engines[0].id); }, [caps, provider, setProvider]);
  useEffect(() => { if (voices.length && !voices.some((v) => v.id === voice)) setVoice(voices[0].id); }, [voices, voice, setVoice]);
  useEffect(() => { if (docId) void downloadStats(docId).then(setStats); }, [docId, busy]);

  if (!user) return <p className="hint">Sign in to use natural voices.</p>;
  if (!caps) return <p className="hint">Natural voices are not available on this server yet.</p>;
  if (!caps.engines.length) return <p className="hint">No voice engine is switched on for this server yet.</p>;
  const canVoice = hasFeature(plan, 'natural_tts');
  const canOffline = hasFeature(plan, 'offline_audio');
  const fail = (e: unknown) => setMsg(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.');

  const preview = async () => {
    setBusy('preview'); setMsg(null);
    try {
      const blob = await apiBlob('/v1/preview', { provider, voice });
      audio.current?.pause();
      audio.current = new Audio(URL.createObjectURL(blob));
      await audio.current.play();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const download = async () => {
    setBusy('download'); setMsg(null); cancel.current = { cancelled: false };
    try { await downloadDocumentAudio((done, total) => setProgress({ done, total }), cancel.current); }
    catch (e) { fail(e); } finally { setBusy(null); setProgress(null); }
  };

  return (
    <div className="stack">
      {!canVoice && <p className="locked"><Lock size={16} /> Natural voices are included with Plus.</p>}
      <label className="check-row"><input type="checkbox" checked={on && canVoice} disabled={!canVoice} onChange={(e) => setOn(e.target.checked)} /> Use a natural voice when listening</label>
      <div className="inline-form">
        <label className="field grow">Engine
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>{caps.engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
        </label>
        <label className="field grow">Voice
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>{voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
        </label>
      </div>
      <div className="row-end">
        <button className="btn" disabled={!voice || busy !== null} onClick={() => void preview()}><Play size={16} /> {busy === 'preview' ? 'Loading…' : 'Hear a sample'}</button>
      </div>
      {docId && (
        <div className="stack">
          {!canOffline ? <p className="locked"><Lock size={16} /> Offline audio is included with Plus.</p> : progress ? (
            <div><span className="bar" aria-hidden><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></span>
              <p className="hint" role="status">Downloading part {Math.min(progress.done + 1, progress.total)} of {progress.total}…</p>
              <button className="btn" onClick={() => { cancel.current.cancelled = true; }}>Stop</button></div>
          ) : (
            <div className="row-end">
              {stats && stats.chunks > 0 && <span className="hint grow">{stats.chunks} parts saved, {(stats.bytes / 1048576).toFixed(1)} MB</span>}
              {stats && stats.chunks > 0 && <button className="btn" onClick={() => void removeDownloads(docId).then(() => setStats({ chunks: 0, bytes: 0 }))}><Trash2 size={16} /> Remove</button>}
              <button className="btn" disabled={!canVoice || !voice || busy !== null} onClick={() => void download()}><Download size={16} /> Download for offline</button>
            </div>
          )}
        </div>
      )}
      {docId && <ExportBox docId={docId} allowed={hasFeature(plan, 'audio_export')} ready={canVoice && !!voice} />}
      {msg && <p role="alert" className="error-text">{msg}</p>}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = { queued: 'Waiting to start', generating: 'Creating the audio', packaging: 'Adding chapters', ready: 'Ready', failed: 'Something went wrong' };

/** Turns the whole document into one audiobook file with chapters. Runs on the server, so you can leave and come back. */
function ExportBox({ docId, allowed, ready }: { docId: string; allowed: boolean; ready: boolean }) {
  const key = `export-job:${docId}`;
  const [format, setFormat] = useState<'mp3' | 'm4b'>('mp3');
  const [job, setJob] = useState<ExportStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = !!job && ['queued', 'generating', 'packaging'].includes(job.state);

  useEffect(() => { const id = localStorage.getItem(key); if (id) exportStatus(id).then(setJob).catch(() => localStorage.removeItem(key)); }, [key]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { exportStatus(job!.id).then(setJob).catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [active, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true); setErr(null);
    try { const id = await startAudioExport(format); localStorage.setItem(key, id); setJob({ id, state: 'queued', progress: 0, error: null, result: null }); }
    catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  };
  const reset = () => { localStorage.removeItem(key); setJob(null); };

  return (
    <div className="stack export-box">
      <h3 className="sub left">Audiobook file</h3>
      {!allowed ? <p className="locked"><Lock size={16} /> Exporting an audio file is included with Pro.</p> : (
        <>
          {!job && (
            <div className="row-end">
              <label className="field grow">Format
                <select value={format} onChange={(e) => setFormat(e.target.value as 'mp3' | 'm4b')}>
                  <option value="mp3">MP3 (plays everywhere)</option><option value="m4b">M4B (audiobook apps, remembers your place)</option>
                </select>
              </label>
              <button className="btn" disabled={!ready || busy} onClick={() => void start()}><FileAudio size={16} /> Create file</button>
            </div>
          )}
          {job && (
            <div className="stack">
              <p role="status"><strong>{STATE_LABEL[job.state] ?? job.state}</strong>{active && ` · ${Math.round(job.progress * 100)}%`}</p>
              {active && <span className="bar" aria-hidden><span style={{ width: `${job.progress * 100}%` }} /></span>}
              {active && <p className="hint">This can take a while for a long book. You can close this and come back.</p>}
              {job.error && <p role="alert" className="error-text">{job.error}</p>}
              {job.result && <a className="btn primary" href={job.result.url} download><Download size={16} /> Download {job.result.ext.toUpperCase()} · {(job.result.bytes / 1048576).toFixed(1)} MB · {job.result.chapters} {job.result.chapters === 1 ? 'chapter' : 'chapters'}</a>}
              {!active && <button className="btn" onClick={reset}>{job.state === 'failed' ? 'Try again' : 'Make a new file'}</button>}
            </div>
          )}
        </>
      )}
      {err && <p role="alert" className="error-text">{err}</p>}
    </div>
  );
}
