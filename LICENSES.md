# Licenses

Status of every entry is **not yet reviewed**. Licenses below are what each project states as far as I know; confirm against the version you install before shipping a paid product. Pin exact versions and source URLs here when you do.

| Component | Stated license | Notes |
|---|---|---|
| React, React DOM | MIT | |
| Vite, @vitejs/plugin-react | MIT | |
| vite-plugin-pwa, Workbox | MIT | |
| Dexie, dexie-react-hooks | Apache-2.0 | |
| lucide-react | ISC | |
| pdfjs-dist | Apache-2.0 | |
| mammoth | BSD-2-Clause | |
| JSZip | MIT or GPL-3.0 (dual) | Use under MIT. |
| @supabase/supabase-js | MIT | |
| Tesseract.js | Apache-2.0 | Language data downloads at first use. |
| @mozilla/readability | Apache-2.0 | Server-side article extraction. |
| linkedom | ISC | |
| FFmpeg (installed in the server image) | LGPL/GPL depending on build | Run as a separate program to encode MP3. Check the Debian build's terms if you redistribute the image. |
| Inter, Literata (via @fontsource-variable) | SIL OFL 1.1 | Attribution and font-file terms apply. |

## TTS engines and voices

| Engine | Concern |
|---|---|
| Browser SpeechSynthesis | Uses voices installed on the user's device, licensed by the OS vendor. No server cost. |
| Edge TTS (`edge-tts-universal`) | Library is AGPL-3.0-or-later (v1.4.0) and Microsoft's service is an unofficial route. Kept optional and restricted to the owner's account by `EDGE_TTS_ALLOWED_USER_IDS`. Do not offer to customers. |
| ElevenLabs | Paid service. Whether you may resell audio depends on your ElevenLabs plan and its terms. Check before charging customers. |
| Kokoro-FastAPI server image | Reported Apache-2.0, running the Kokoro model (also reported Apache-2.0). Confirm both for the exact version you deploy. |
| OpenAI-compatible endpoint | The server sends text to whatever endpoint you configure. Review that provider's terms and the license of the model behind it (Kokoro: Apache-2.0 as reported). |
| Kokoro | Reported Apache-2.0 model and code. Confirm the exact weights and voice pack you download. |
| Piper | Code license changed across versions, and each voice model has its own license. Check both. |
| VoiceStudio | AGPL-3.0, and its default model may be non-commercial. Keep it as a separate internal tool. |

## Scripture translations (tapestry, later)

Store `translation_name`, `abbreviation`, `copyright_notice`, `license_name`, `license_url`, `source_url` per translation before importing any text.
