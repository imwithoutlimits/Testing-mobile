export interface Voice { id: string; name: string; lang: string }
export interface Pcm { samples: Int16Array; sampleRate: number }
/** Neighbouring sentences, so engines that support it can keep tone and pacing continuous. */
export interface TtsContext { previous?: string; next?: string }
export interface TtsEngine {
  id: string;
  label: string;
  commercialUseAllowed: boolean;
  /** How many sentences may be spoken at once. Providers with strict limits set a lower number. */
  concurrency?: number;
  available(): boolean;
  listVoices(): Promise<Voice[]>;
  synthesize(text: string, voice: string, ctx?: TtsContext): Promise<Pcm>;
}
