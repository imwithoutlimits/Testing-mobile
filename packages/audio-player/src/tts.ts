// Provider abstraction from the PRD. The player and document model never import a concrete provider.
export interface TtsInput {
  text: string;
  voiceId: string;
  speed?: number;
  lang?: string;
}
export interface TtsOutput {
  audio: Blob;
  mime: string;
  durationMs?: number;
  /** Word or sentence timestamps relative to the start of this audio, if the engine provides them. */
  timestamps?: Array<{ startMs: number; endMs: number; text: string }>;
}
export interface TtsVoice { id: string; name: string; lang: string; gender?: 'female' | 'male' | 'neutral'; category?: string }

export interface TtsProvider {
  id: string;
  name: string;
  capabilities: {
    streaming: boolean;
    timestamps: boolean;
    voiceCloning: boolean;
    multipleSpeakers: boolean;
    commercialUseAllowed: boolean;
  };
  listVoices(): Promise<TtsVoice[]>;
  synthesize(input: TtsInput): Promise<TtsOutput>;
}

/** One generated audio chunk covering several utterances (a section), as returned by the tts-worker. */
export interface AudioChunk {
  url: string;
  /** index = position in the utterance list; startMs = offset inside this chunk's audio */
  items: Array<{ index: number; startMs: number }>;
  durationMs: number;
}

export interface ChunkRequest {
  documentId: string;
  voiceId: string;
  provider: string;
  utterances: Array<{ index: number; spoken: string; pauseAfterMs: number }>;
}

/** Client for the server-side tts-worker (Render). Kokoro, Piper, Edge and VoiceStudio sit behind it. */
export class ServerTtsClient {
  private baseUrl: string;
  private getToken: () => Promise<string | null>;
  constructor(baseUrl: string, getToken: () => Promise<string | null>) {
    this.baseUrl = baseUrl;
    this.getToken = getToken;
  }
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Voice service error (${res.status}). Try again, or switch to your device voice.`);
    return (await res.json()) as T;
  }
  listVoices(provider: string) { return this.call<TtsVoice[]>(`/v1/voices?provider=${encodeURIComponent(provider)}`); }
  generateChunk(req: ChunkRequest) { return this.call<AudioChunk>('/v1/chunks', req); }
}
