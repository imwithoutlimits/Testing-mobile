insert into feature_flags (key, enabled, description) values
  ('voice_cloning', false, 'Consent-gated voice cloning (not in v1)'),
  ('quizzes', true, 'Quiz and flashcard generation'),
  ('ask_document', true, 'Ask this document'),
  ('server_tts', true, 'Server-side TTS provider')
on conflict (key) do nothing;
