const e = (k: string, d = ''): string => process.env[k] ?? d;
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export const config = {
  port: Number(e('PORT', '10000')),
  supabaseUrl: e('SUPABASE_URL').replace(/\/$/, ''),
  // New projects have sb_publishable_ / sb_secret_ keys. The older anon / service_role names are still accepted.
  anonKey: e('SUPABASE_PUBLISHABLE_KEY') || e('SUPABASE_ANON_KEY'),
  serviceKey: e('SUPABASE_SECRET_KEY') || e('SUPABASE_SERVICE_ROLE_KEY'),
  allowedOrigins: list(e('ALLOWED_ORIGINS')),
  ls: { secret: e('LEMON_SQUEEZY_SIGNING_SECRET'), plus: e('LS_VARIANT_EARSHELF_PLUS'), pro: e('LS_VARIANT_EARSHELF_PRO') },
  sentryDsn: e('SENTRY_DSN'),
  embed: { base: e('EMBED_BASE_URL').replace(/\/$/, ''), key: e('EMBED_API_KEY'), model: e('EMBED_MODEL', 'text-embedding-3-small'), dims: 384 },
  tts: {
    sampleRate: 24000,
    kokoroHostPort: e('TTS_KOKORO_HOSTPORT'),
    eleven: { key: e('ELEVENLABS_API_KEY'), base: 'https://api.elevenlabs.io', model: e('ELEVENLABS_MODEL', 'eleven_multilingual_v2'), voiceIds: list(e('ELEVENLABS_VOICE_IDS')), concurrency: Number(e('ELEVENLABS_CONCURRENCY', '2')), stability: 0.5 },
    openaiBase: e('TTS_OPENAI_BASE_URL').replace(/\/$/, ''),
    openaiKey: e('TTS_OPENAI_API_KEY'),
    openaiModel: e('TTS_OPENAI_MODEL', 'kokoro'),
    openaiFormat: e('TTS_OPENAI_FORMAT', 'pcm') as 'pcm' | 'mp3' | 'wav',
    openaiVoices: list(e('TTS_OPENAI_VOICES', 'af_heart,af_bella,af_nicole,am_michael,am_fenrir,bf_emma,bm_george')),
    edgeEnabled: e('EDGE_TTS_ENABLED') === 'true',
    edgeUsers: new Set(list(e('EDGE_TTS_ALLOWED_USER_IDS'))),
  },
  ai: { provider: e('AI_PROVIDER', 'anthropic'), key: e('AI_API_KEY'), model: e('AI_MODEL', 'claude-haiku-4-5-20251001'), base: e('AI_BASE_URL').replace(/\/$/, '') },
};
