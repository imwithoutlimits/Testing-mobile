import { useState } from 'react';
import { ChevronDown, Bookmark, Moon, Pause, Play, RotateCcw, SkipBack, SkipForward, Volume2, FileText, Rewind, FastForward, SkipForward as Skip } from 'lucide-react';
import { formatDuration, player, useSetting, usePlayer, useVoices } from '../hooks';
import type { SleepSetting } from '@wells/audio-player';
import { db, queueSync, uid } from '../db';
import { Sheet } from './Sheet';
import { NaturalVoice } from './NaturalVoice';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP: Array<{ label: string; value: SleepSetting | null }> = [
  { label: 'Off', value: null },
  { label: '15 minutes', value: { kind: 'minutes', minutes: 15 } },
  { label: '30 minutes', value: { kind: 'minutes', minutes: 30 } },
  { label: '60 minutes', value: { kind: 'minutes', minutes: 60 } },
  { label: 'End of section', value: { kind: 'end-of-section' } },
];
const sleepLabel = (s: SleepSetting | null) => SLEEP.find((o) => JSON.stringify(o.value) === JSON.stringify(s))?.label ?? 'Off';

export function PlayerBar({ onOpenReader }: { onOpenReader: (docId: string) => void }) {
  const s = usePlayer();
  const [open, setOpen] = useState(false);
  const voices = useVoices();
  const [voiceURI, setVoiceURI] = useSetting<string | null>('voiceURI', null);
  const [, setRate] = useSetting('rate', 1);
  if (!s.documentId || !s.length) return null;
  const playing = s.status === 'playing' || s.status === 'loading';

  const addBookmark = async () => {
    if (!s.utterance || !s.documentId) return;
    const now = Date.now();
    const id = uid();
    await db.annotations.add({ id, docId: s.documentId, kind: 'bookmark', blockId: s.utterance.blockId, utteranceIndex: s.index, text: s.utterance.text, createdAt: now, updatedAt: now });
    await queueSync('bookmarks', id);
  };

  return (
    <>
      <div className="miniplayer" role="region" aria-label="Player">
        <button className="mini-main" onClick={() => setOpen(true)} aria-label="Open full player">
          <span className="mini-title">{s.title}</span>
          <span className="mini-sub">{s.status === 'loading' ? 'Preparing audio…' : s.sectionTitle || (s.status === 'error' ? s.error : formatDuration(s.remainingSeconds) + ' left')}</span>
        </button>
        <button className="icon-btn" onClick={() => player.back(15)} aria-label="Back 15 seconds"><Rewind size={20} /></button>
        <button className="icon-btn primary" onClick={() => player.toggle()} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <div className="progress-line" style={{ width: `${(s.index / Math.max(1, s.length - 1)) * 100}%` }} aria-hidden />
      </div>

      {open && (
        <Sheet onClose={() => setOpen(false)} label="Full player" className="full-player">
            <button className="icon-btn sheet-close" onClick={() => setOpen(false)} aria-label="Close player"><ChevronDown size={24} /></button>
            <h2 className="fp-title">{s.title}</h2>
            <p className="fp-section">{s.sectionTitle}</p>
            <p className="fp-line reading">{s.utterance?.text}</p>
            {s.error && <p role="alert" className="error-text">{s.error}</p>}

            <input type="range" className="scrubber" min={0} max={Math.max(0, s.length - 1)} value={s.index}
              onChange={(e) => player.seekTo(Number(e.target.value))} aria-label="Position in document"
              aria-valuetext={`${formatDuration(s.remainingSeconds)} left`} />
            <div className="fp-times"><span>{Math.round((s.index / Math.max(1, s.length - 1)) * 100)}%</span><span>{formatDuration(s.remainingSeconds)} left</span></div>

            <div className="fp-controls">
              <button className="icon-btn" onClick={() => player.previous()} aria-label="Previous paragraph"><SkipBack size={24} /></button>
              <button className="icon-btn" onClick={() => player.back(15)} aria-label="Back 15 seconds"><Rewind size={24} /></button>
              <button className="icon-btn primary big" onClick={() => player.toggle()} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
                {playing ? <Pause size={30} /> : <Play size={30} />}
              </button>
              <button className="icon-btn" onClick={() => player.forward(30)} aria-label="Forward 30 seconds"><FastForward size={24} /></button>
              <button className="icon-btn" onClick={() => player.nextSection()} aria-label="Next section"><SkipForward size={24} /></button>
            </div>

            <div className="fp-row">
              <button className="chip" onClick={() => player.replaySentence()}><RotateCcw size={16} /> Replay sentence</button>
              <button className="chip" onClick={() => player.replayParagraph()}><RotateCcw size={16} /> Replay paragraph</button>
              <button className="chip" onClick={() => player.skipHeading()}><Skip size={16} /> Skip heading</button>
              <button className="chip" onClick={() => void addBookmark()}><Bookmark size={16} /> Bookmark</button>
              <button className="chip" onClick={() => { setOpen(false); onOpenReader(s.documentId!); }}><FileText size={16} /> Transcript</button>
            </div>

            <div className="fp-grid">
              <label>Speed
                <select value={s.rate} onChange={(e) => { const r = Number(e.target.value); player.setRate(r); setRate(r); }}>
                  {SPEEDS.map((r) => <option key={r} value={r}>{r}×</option>)}
                </select>
              </label>
              <label><Moon size={14} /> Sleep timer
                <select value={sleepLabel(s.sleep)} onChange={(e) => player.setSleep(SLEEP.find((o) => o.label === e.target.value)?.value ?? null)}>
                  {SLEEP.map((o) => <option key={o.label}>{o.label}</option>)}
                </select>
              </label>
              <label>Voice
                <select value={voiceURI ?? ''} onChange={(e) => { const v = e.target.value || null; setVoiceURI(v); player.setVoice(v); }}>
                  <option value="">Device default</option>
                  {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
                </select>
              </label>
              <label><Volume2 size={14} /> Volume
                <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => player.setVolume(Number(e.target.value))} />
              </label>
            </div>
            <p className="hint">On some phones, device voices pause when the app is in the background. Natural voices keep playing.</p>
            <h3 className="sub left">Natural voice</h3>
            <NaturalVoice docId={s.documentId} />
        </Sheet>
      )}
    </>
  );
}
