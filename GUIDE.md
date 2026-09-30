# earshelf: go-live guide (no terminal, no npm)

You will never type `npm run build` or `npm run dev`. GitHub holds the code. Netlify builds the website from GitHub. Render runs the server from GitHub. Supabase stores the data. Everything is clicking and pasting.

Plan for 1 to 2 hours the first time. Do the parts **in order**. Keep the "Notes" table (bottom) open in another tab and paste values into it as you go.

Buttons and menus on these sites get renamed now and then. If a label is slightly different, look for the closest match. If you get stuck, take a screenshot and send it to me.

---

## Part 1. Put the code on GitHub

1. Go to github.com and sign in (or create a free account).
2. Click the **+** at the top right, then **New repository**.
3. Name it `earshelf`. Choose **Private**. Leave everything else alone. Click **Create repository**.
4. On your computer, unzip `earshelf-monorepo.zip`. You get a folder called `wells`.
5. **Show hidden files** so the dotted files are included:
   - Mac: in Finder press `Cmd + Shift + .`
   - Windows: in File Explorer choose View, then Show, then Hidden items.
6. On the new empty repository page, click **uploading an existing file**.
7. GitHub only accepts about 100 files per upload, so upload in **three rounds**. In each round, open the `wells` folder and drag the items *inside* it into the GitHub page, wait until the list finishes, type a short note like "part 1" in the box at the bottom, and click **Commit changes**. Then click **Add file, Upload files** for the next round.
   - Round 1: the `apps` folder.
   - Round 2: the `packages` folder and the `services` folder.
   - Round 3: the `supabase` folder, the `.github` folder, and all the loose files (`package.json`, `netlify.toml`, `render.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `README.md`, `GUIDE.md`, `LICENSES.md`).
8. Check: on the repository home page you should see `apps`, `packages`, `services`, `supabase`, `.github`, and `netlify.toml`. Open `apps/earshelf/src` and confirm you can see `App.tsx`.

Easier alternative: install **GitHub Desktop**, choose File, Add local repository, pick the `wells` folder, click Publish repository. It handles all the files at once.

---

## Part 2. Supabase (your database, login and file storage)

1. Go to supabase.com, sign in, click **New project**.
2. Give it a name (`earshelf`), create a **database password** and save it in your password manager, pick the region closest to you, click **Create new project**. Wait a couple of minutes.
3. **Create the tables.** In the left menu click **SQL Editor**, then **New query**.
   1. On GitHub open `supabase/migrations/0001_shared_foundation.sql`, click the **Copy raw file** button, paste into the Supabase editor, click **Run**. You should see "Success. No rows returned."
   2. Repeat with `0002_earshelf.sql`.
   3. Repeat with `0003_sync_and_content.sql`.
   4. Repeat with `0004_semantic_srs_export.sql`.
   5. Repeat with `supabase/seed.sql`.
   - If any one shows a red error, stop and send me the exact message. If it mentions an extension, open **Database, Extensions**, switch on `vector`, `pg_trgm` and `pgcrypto`, and run that file again.
4. **Turn off email confirmation for now** (so you can test without waiting for emails): **Authentication, Sign In / Providers, Email**, switch **Confirm email** off, **Save**.
5. **Get your keys:** click the gear (**Project Settings**), then **API Keys**.
   - If you see a **Create new API keys** button, click it.
   - Copy the **Project URL** (top of the page or under Data API) into Notes.
   - Copy the **Publishable key** (starts with `sb_publishable_`) into Notes. This one is safe to put in the website.
   - Copy the **Secret key** (starts with `sb_secret_`) into Notes. **This one is a master key. It goes only into Render. Never paste it into GitHub, Netlify, or a chat.**
6. Check storage: **Storage** in the left menu. You should see two buckets, `originals` and `audio`, both marked private.

---

## Part 3. Netlify (the website)

1. Go to netlify.com, sign in with GitHub.
2. **Add new site, Import an existing project, GitHub.** Allow access, choose the `earshelf` repository.
3. The build settings fill themselves in from `netlify.toml` (Build command `npm run build`, Publish directory `apps/earshelf/dist`). Leave them.
4. Click **Add environment variables** (or set them after, under **Site configuration, Environment variables**) and add these two now:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = your publishable key
5. Click **Deploy**. It takes a few minutes.
6. **If the deploy fails** (red): click the failed deploy, scroll to the bottom of the log, copy the last 60 lines, and send them to me. I wrote this without being able to run the build, so a small fix here is possible and normal.
7. When it turns green you get an address like `https://something.netlify.app`. Write it in Notes. You can change the name under **Site configuration, Change site name**.
8. Back in Supabase: **Authentication, URL Configuration.** Set **Site URL** to your Netlify address. Under **Redirect URLs** add the same address, and again with `/**` on the end. Save.

---

## Part 4. Render (the server for voices, AI, link import and payments)

1. Go to render.com, sign in with GitHub.
2. Click **New, Blueprint**. Connect the `earshelf` repository. Render reads `render.yaml` and lists the settings to fill in.
3. Fill in the values (leave a box empty if you don't have it yet, you can add it later under **Environment**):

| Name | What to put |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | publishable key |
| `SUPABASE_SECRET_KEY` | secret key |
| `ALLOWED_ORIGINS` | your Netlify address exactly, no slash at the end |
| `AI_API_KEY` | key for the AI provider (see Part 7) |

   The voice, Lemon Squeezy and other boxes are filled in later parts.
4. Choose an **always-on paid instance**. Free instances go to sleep and are small, which is a bad fit for generating audio.
5. Click **Apply** and wait for the first build (several minutes; it installs audio tools).
6. Copy the service address (like `https://earshelf-api-xxxx.onrender.com`) into Notes. Open `that-address/health` in your browser. You should see `{"ok":true}`.
7. **Tell the website where the server is.** Back in Netlify, **Environment variables**, add `VITE_API_URL` = the Render address. Then go to **Deploys, Trigger deploy, Deploy site**. (Website settings only take effect on a new deploy.)

---

## Part 5. First test (about 10 minutes)

1. Open your Netlify address. Create an account with an email and a password (8+ characters).
2. Tap **Add**, choose **Paste text**, paste a few paragraphs, **Continue**, **Add to library**.
3. Press **Listen**. You should hear your device's voice reading, with the sentence highlighted.
4. Go to **Profile**. It should say **Up to date**.
5. In Supabase open **Table Editor, documents**. Your document is there. That is your proof it is stored in Supabase.
6. Open the site on your phone, sign in, and your document appears.
7. **Give yourself the Pro plan for testing, without paying:** in Supabase, **Authentication, Users**, copy your **User UID**. Then **Table Editor, entitlements, Insert row**: `user_id` = your UID, `product` = `earshelf`, `plan` = `pro`, `active` = true. In the app open Profile and tap **Sync now**. It should say you are on the pro plan.

**Install it like an app:** on iPhone open the site in Safari, tap Share, **Add to Home Screen**. On Android open it in Chrome, menu, **Add to Home screen** or **Install app**.

---

## Part 6. Natural voices

Open **Profile, Natural voices** and use **Hear a sample** to compare. You can switch on several engines at once and pick per document. Add the settings on Render under **Environment**, save, and Render redeploys by itself.

**Option A: Kokoro, one click (free voices, runs on your own Render server)**
1. In Render click **New, Blueprint**, choose the same `earshelf` repository, and when it asks for the **Blueprint file path** enter `render.kokoro.yaml`. (If you do not see a path box, tell me and I will merge it into the main file.)
2. Click **Apply**. A private service called `kokoro-tts` appears. It is not reachable from the internet, only from your earshelf server. It uses a paid instance with about 2 GB of memory, so check Render's pricing first. You can suspend it any time.
3. In the `earshelf-api` service open **Environment** and add `TTS_KOKORO_HOSTPORT` = `kokoro-tts:8880`. Save.
4. In the app, Profile, Natural voices, choose **Kokoro (free open voices)**. The first sample can take longer while the model wakes up.
I could not run Kokoro here. The image and port come from the project's documented defaults. If a sample fails, open the `kokoro-tts` Logs tab and send me what it says.

**Option B: ElevenLabs (the most expressive voices, pay per character)**
- Create an account at elevenlabs.io, open your profile, **API Keys**, create one.
- `ELEVENLABS_API_KEY` = your key.
- Optional: `ELEVENLABS_VOICE_IDS` = a comma separated list of the voice ids you want to offer (each voice's id is on its page), so your list stays short. `ELEVENLABS_MODEL` defaults to `eleven_multilingual_v2`.
- Optional: `ELEVENLABS_CONCURRENCY` (default 2). Lower it if you see "busy" errors.
- earshelf passes the neighbouring sentences to ElevenLabs so the tone flows from one sentence to the next, which makes long reading sound less choppy.
- This is the priciest option per minute. Check that your ElevenLabs plan allows commercial use before you sell access, and consider lowering the monthly minutes in `packages/billing/src/plans.ts`.

**Option C: OpenAI voices (easy, pay per use)**
- Create an API key at platform.openai.com.
- `TTS_OPENAI_BASE_URL` = `https://api.openai.com/v1`, `TTS_OPENAI_API_KEY` = your key, `TTS_OPENAI_MODEL` = `tts-1`, `TTS_OPENAI_VOICES` = `alloy,nova,onyx,shimmer,echo,fable`.

**Option D: Edge voices, for you only**
- `EDGE_TTS_ENABLED` = `true` and `EDGE_TTS_ALLOWED_USER_IDS` = your User UID from Supabase.
- Microsoft's online voices through an unofficial route. Only the accounts you list can use them. Do not offer them to customers.

**How human will it sound?** Trust your ears with **Hear a sample**. Reviews I found put Kokoro close to premium services for plain English narration, but flatter for fiction and emotion. ElevenLabs is still the benchmark for expressive reading.

Usage limits protect your bill: Plus gets 600 natural-voice minutes a month, Pro 3,000. Change them in `packages/billing/src/plans.ts`.

---

## Part 7. AI (summaries, questions, quizzes)

On Render, **Environment**:
- Using Claude: `AI_PROVIDER` = `anthropic`, `AI_API_KEY` = your key from console.anthropic.com, `AI_MODEL` = `claude-haiku-4-5-20251001` (already the default).
- Using OpenAI, or a model on your own machine through Ollama: `AI_PROVIDER` = `openai-compatible`, `AI_BASE_URL` = `https://api.openai.com/v1` (or your Ollama address ending in `/v1`), `AI_API_KEY`, and `AI_MODEL`.

Test: open a document, tap the sparkle button at the top, choose **Summary**, tap **Create**.

**Search by meaning (finds passages by idea, not just exact words)**
- It needs an embedding service. An OpenAI key works: `EMBED_API_KEY` = your OpenAI key (the default model `text-embedding-3-small` is set up to return the 384 numbers the database expects).
- Using Ollama or another OpenAI-style server instead: `EMBED_BASE_URL` = its address ending in `/v1`, and `EMBED_MODEL` = a model that returns 384 numbers (for example `all-minilm`). If the numbers do not match, earshelf says so plainly.
- Once on, signed-in Plus and Pro accounts get their documents prepared automatically after each sync (each document counts as one AI request that month). Then tick **Search by meaning** on the Search page (Pro searches the whole library) or in a document's search panel (Plus and Pro).

---

## Part 8. Payments with Lemon Squeezy (do this last)

Stay in **Test mode** the whole time (there is a switch near the top or bottom of the dashboard).

1. Sign up at lemonsqueezy.com and create a store.
2. **Products, New product.** Create **earshelf Plus** as a **subscription**, monthly price. Create **earshelf Pro** the same way.
3. On each product click **Share** and copy the **checkout link**. In Netlify add `VITE_LS_CHECKOUT_PLUS` and `VITE_LS_CHECKOUT_PRO`, then trigger a new deploy.
4. **Settings, Webhooks, add one:**
   - Callback URL: `your-render-address/webhooks/lemonsqueezy`
   - Signing secret: make up a long random text and save it in Notes.
   - Tick these events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, `subscription_payment_success`, `subscription_payment_failed`, `order_refunded`.
   - In Render add `LEMON_SQUEEZY_SIGNING_SECRET` = the same signing secret.
5. **Find the two variant numbers.** In the app, Profile, tap **Upgrade to Plus** and buy with the test card `4242 4242 4242 4242`, any future date, any 3 digits. Then in Supabase open **Table Editor, billing_events**, click the newest row's `payload`, and find `variant_id`. Do the same for Pro. In Render add `LS_VARIANT_EARSHELF_PLUS` and `LS_VARIANT_EARSHELF_PRO`.
6. Those first test events were recorded before the numbers were known. In Supabase delete the rows in `billing_events`, then in Lemon Squeezy open the webhook's recent deliveries and click **Resend**. Now the plan should switch to Plus or Pro in the app, a few seconds after Profile, **Sync now**.
7. To go live later: switch off Test mode, recreate the products, webhook and links, and update the values.

The app never trusts the "thank you" page. It only unlocks a plan when Lemon Squeezy's signed message reaches your server.

---

## Part 9. Error alerts (optional, recommended)

So you hear about crashes before customers tell you.
1. Create a free account at sentry.io (or run GlitchTip, an open-source look-alike; both use the same address format).
2. Create one project for the website and one for the server (or use one for both). Copy each project's **DSN** (a web address that starts with `https://`).
3. Netlify: add `VITE_SENTRY_DSN` = the website project's DSN, then trigger a new deploy. Render: add `SENTRY_DSN` = the server project's DSN.
What is sent: the error message, where it happened, a technical trace, and your account's id. Email addresses, tokens and keys are removed first, and document text is never included. The same error is reported at most once a minute.

---

## Part 10. Using the newer features

- **Review cards:** open a document, tap the sparkle button, **Quiz**, then **Make flashcards** (or **Make a quiz**) and **Save all for review**. A **cards to review** card appears on Home and Activity. Forgotten cards return sooner, easy ones later.
- **A voice style for a well:** Wells, open a well, **Voice style for this well**. Documents opened from it use that pace and those pauses.
- **Explain a table or figure (Pro):** tap **Explain this** under a table or a figure caption. For figures it works from the caption and the surrounding text only, and says so, because it does not look at the picture yet.
- **Audiobook file (Pro):** open a document, tap the player, **Natural voice**, then **Audiobook file**. Pick MP3 or M4B, tap **Create file**, and come back when it says Ready. The file has one chapter per section. Parts that were already created are reused, so a retry is quick.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Netlify build is red | Copy the last 60 lines of the deploy log and send them to me. |
| Page stays on "Loading…" or is blank | Netlify environment variables missing or misspelled. Fix, then trigger a new deploy. |
| "Invalid API key" when signing in | You pasted the wrong key. Use the **publishable** key (or the older `anon` key) on Netlify. |
| "Could not reach the earshelf server" | `VITE_API_URL` is wrong, or `ALLOWED_ORIGINS` on Render does not match your Netlify address exactly. |
| "Sign in to use this" in Render logs, or 401 | `SUPABASE_URL` or the keys on Render are wrong. |
| Natural voice does not play | Render, **Logs** tab. The error says what failed. If it says the voice server returned an error, check the `TTS_` values. |
| Sync says there was a problem | Read the message under Profile. Most often a SQL file was skipped. Run all five again in order. |
| "Search by meaning" finds nothing | New documents are prepared in the background after a sync. Wait a minute and try again. Check `EMBED_API_KEY` on Render. |
| Audiobook export stops with an error | Read the message. Usually the monthly voice minutes ran out or the voice provider was busy. Start it again; finished parts are reused. |
| A sign-up email never arrives | Supabase's built-in email is heavily rate limited. Keep "Confirm email" off while testing. |

## Keep safe
- The **Secret key**, the **signing secret** and any API keys live only in Render. If one leaks, replace it in Supabase, Lemon Squeezy or the provider, then update Render.
- Supabase free projects can pause after a period of inactivity. If the site suddenly cannot sign in, open the Supabase dashboard and restore the project.

## Notes (paste values here, keep private)

| Item | Value |
|---|---|
| Supabase Project URL | |
| Supabase publishable key | |
| Supabase secret key (Render only) | |
| Netlify address | |
| Render address | |
| Lemon Squeezy signing secret | |
| Plus variant number | |
| Pro variant number | |
| My User UID | |
