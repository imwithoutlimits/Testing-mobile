import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PronunciationEntry, ReadingMode } from '../../../packages/core/src/index.ts';
import type { Feature, Plan } from '../../../packages/billing/src/plans.ts';
import { config } from './config.ts';
import { deleteUserContent, getUser, rest } from './supa.ts';
import { HttpError, consume, getPlan, requireFeature } from './entitlements.ts';
import { processWebhook } from './billing.ts';
import { fetchArticle } from './article.ts';
import { engineFor, enginesFor } from './tts/engines.ts';
import { generateChunk, loadDocument } from './tts/generate.ts';
import { pcmToMp3 } from './tts/ffmpeg.ts';
import { getAiProvider } from './ai/provider.ts';
import { ask, flashcards, isSummaryKind, quiz, summarize, PROMPT_VERSION } from './ai/tasks.ts';
import { explain } from './ai/explain.ts';
import { indexDocument, makeEmbedder, realSearchRpc, replaceChunks, semanticSearch } from './semantic.ts';
import { jobStatus, startExport } from './exportJob.ts';
import { report } from './monitor.ts';

type Json = Record<string, unknown>;
interface Ctx { user: { id: string }; body: Json; query: URLSearchParams; plan: () => Promise<Plan> }
interface Route { auth: boolean; run: (c: Ctx) => Promise<unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: ReadingMode[] = ['clean', 'complete', 'audiobook', 'study', 'accessibility'];
const bad = (m: string) => new HttpError(400, 'bad_request', m);

const hits = new Map<string, number[]>();
function limit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
  arr.push(now);
  hits.set(key, arr);
}

const docId = (b: Json) => { if (typeof b.documentId !== 'string' || !UUID.test(b.documentId)) throw bad('Missing or invalid documentId.'); return b.documentId; };
const prons = (b: Json): PronunciationEntry[] => (Array.isArray(b.pronunciations) ? (b.pronunciations as Json[]).filter((p) => typeof p.term === 'string' && typeof p.say === 'string').slice(0, 500).map((p) => ({ term: p.term as string, say: p.say as string })) : []);

async function aiRun<T>(c: Ctx, feature: Feature, kind: string, fn: (ai: NonNullable<ReturnType<typeof getAiProvider>>, doc: Awaited<ReturnType<typeof loadDocument>>) => Promise<T>): Promise<T> {
  const ai = getAiProvider();
  if (!ai) throw new HttpError(503, 'ai_unavailable', 'AI features are not switched on for this server.');
  const plan = await c.plan();
  requireFeature(plan, feature);
  limit(`ai:${c.user.id}`, 60, 3600_000);
  await consume(c.user.id, plan, 'ai_requests', 1);
  const doc = await loadDocument(c.user.id, docId(c.body));
  try {
    const out = await fn(ai, doc);
    void rest('ai_generations', { method: 'POST', prefer: 'return=minimal', body: { user_id: c.user.id, product: 'earshelf', kind, provider: ai.id, model: ai.model, prompt_version: PROMPT_VERSION, input_ref: { documentId: c.body.documentId }, output: out } }).catch(() => {});
    return out;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'ai_failed', e instanceof Error ? e.message : 'The AI request failed.');
  }
}

const routes: Record<string, Route> = {
  'GET /health': { auth: false, run: async () => ({ ok: true }) },

  'GET /v1/capabilities': { auth: true, run: async (c) => ({
    plan: await c.plan(),
    engines: enginesFor(c.user.id).map((e) => ({ id: e.id, label: e.label, commercialUseAllowed: e.commercialUseAllowed })),
    ai: !!getAiProvider(),
    embeddings: !!makeEmbedder(),
  }) },

  'POST /v1/account/delete-content': { auth: true, run: async (c) => { await deleteUserContent(c.user.id); return { ok: true }; } },

  'GET /v1/article': { auth: true, run: async (c) => {
    limit(`article:${c.user.id}`, 40, 3600_000);
    try { return await fetchArticle(c.query.get('url') ?? ''); }
    catch (e) { throw new HttpError(422, 'article_failed', e instanceof Error ? e.message : 'We could not import that page.'); }
  } },

  'GET /v1/voices': { auth: true, run: async (c) => {
    const e = engineFor(c.query.get('provider') ?? '', c.user.id);
    if (!e) throw new HttpError(404, 'no_such_provider', 'That voice provider is not available.');
    return e.listVoices();
  } },

  'POST /v1/preview': { auth: true, run: async (c) => {
    limit(`preview:${c.user.id}`, 30, 3600_000);
    const e = engineFor(String(c.body.provider ?? ''), c.user.id);
    if (!e) throw new HttpError(404, 'no_such_provider', 'That voice provider is not available.');
    const text = String(c.body.text ?? 'This is how your documents will sound when they are read to you.').slice(0, 300);
    const pcm = await e.synthesize(text, String(c.body.voice ?? ''));
    return { __binary: await pcmToMp3(pcm.samples, pcm.sampleRate), type: 'audio/mpeg' };
  } },

  'POST /v1/chunks': { auth: true, run: async (c) => {
    const plan = await c.plan();
    requireFeature(plan, 'natural_tts');
    const e = engineFor(String(c.body.provider ?? ''), c.user.id);
    if (!e) throw new HttpError(404, 'no_such_provider', 'That voice provider is not available.');
    const mode = c.body.mode as ReadingMode;
    const idx = Number(c.body.chunkIndex), scale = Number(c.body.pauseScale ?? 1), updated = Number(c.body.updatedAt);
    if (!MODES.includes(mode) || !Number.isInteger(idx) || idx < 0 || !(scale >= 0.5 && scale <= 2) || !Number.isFinite(updated) || typeof c.body.voice !== 'string') throw bad('Invalid audio request.');
    limit(`chunks:${c.user.id}`, 120, 3600_000);
    return generateChunk({
      userId: c.user.id, docId: docId(c.body), docUpdatedAt: updated, chunkIndex: idx, engine: e, voice: c.body.voice, mode, pauseScale: scale,
      prons: plan === 'free' ? [] : prons(c.body),
      beforeSynthesis: async (minutes) => { await consume(c.user.id, plan, 'server_tts_minutes', minutes); },
    });
  } },

  'POST /v1/ai/summary': { auth: true, run: (c) => {
    const kind = String(c.body.kind ?? '');
    if (!isSummaryKind(kind)) throw bad('Unknown summary type.');
    return aiRun(c, 'summaries', `summary:${kind}`, (ai, doc) => summarize(ai, doc, kind));
  } },
  'POST /v1/ai/ask': { auth: true, run: (c) => {
    const q = String(c.body.question ?? '').trim();
    if (q.length < 3 || q.length > 500) throw bad('Ask a question between 3 and 500 characters.');
    return aiRun(c, 'ask_document', 'ask', (ai, doc) => ask(ai, doc, q));
  } },
  'POST /v1/ai/explain': { auth: true, run: (c) => {
    const blockId = String(c.body.blockId ?? '');
    if (!/^b\d{4,}$/.test(blockId)) throw bad('Missing or invalid blockId.');
    return aiRun(c, 'table_figure_explain', 'explain', (ai, doc) => explain(ai, doc, blockId));
  } },

  'POST /v1/index': { auth: true, run: async (c) => {
    const plan = await c.plan();
    requireFeature(plan, 'semantic_search');
    const emb = makeEmbedder();
    if (!emb) throw new HttpError(503, 'embeddings_unavailable', 'Search by meaning is not switched on for this server.');
    const id = docId(c.body);
    const owned = await rest<unknown[]>(`documents?id=eq.${id}&user_id=eq.${c.user.id}&select=id`);
    if (!owned.length) throw new HttpError(404, 'no_such_document', 'That document was not found in your library.');
    limit(`index:${c.user.id}`, 60, 3600_000);
    await consume(c.user.id, plan, 'ai_requests', 1);
    const doc = await loadDocument(c.user.id, id);
    try { return { indexed: await indexDocument({ embed: (t) => emb.embed(t), replace: replaceChunks }, doc, { userId: c.user.id, documentId: id, version: Number(c.body.updatedAt) || Date.now() }) }; }
    catch (e) { throw new HttpError(502, 'index_failed', e instanceof Error ? e.message : 'Indexing failed.'); }
  } },

  'POST /v1/search': { auth: true, run: async (c) => {
    const plan = await c.plan();
    const single = typeof c.body.documentId === 'string' ? docId(c.body) : undefined;
    requireFeature(plan, single ? 'semantic_search' : 'cross_document_search');
    const emb = makeEmbedder();
    if (!emb) throw new HttpError(503, 'embeddings_unavailable', 'Search by meaning is not switched on for this server.');
    const query = String(c.body.query ?? '').trim();
    if (query.length < 2 || query.length > 300) throw bad('Search for between 2 and 300 characters.');
    limit(`search:${c.user.id}`, 120, 3600_000);
    try { return { hits: await semanticSearch({ embed: (t) => emb.embed(t), rpc: realSearchRpc }, { userId: c.user.id, query, documentId: single }) }; }
    catch (e) { throw new HttpError(502, 'search_failed', e instanceof Error ? e.message : 'Search failed.'); }
  } },

  'POST /v1/export/audio': { auth: true, run: async (c) => {
    const plan = await c.plan();
    requireFeature(plan, 'audio_export');
    const e = engineFor(String(c.body.provider ?? ''), c.user.id);
    if (!e) throw new HttpError(404, 'no_such_provider', 'That voice provider is not available.');
    const mode = c.body.mode as ReadingMode, scale = Number(c.body.pauseScale ?? 1), updated = Number(c.body.updatedAt);
    const format = c.body.format === 'm4b' ? 'm4b' : 'mp3';
    if (!MODES.includes(mode) || !(scale >= 0.5 && scale <= 2) || !Number.isFinite(updated) || typeof c.body.voice !== 'string') throw bad('Invalid export request.');
    const jobId = await startExport({
      userId: c.user.id, docId: docId(c.body), docUpdatedAt: updated, engine: e, voice: c.body.voice, mode, pauseScale: scale, format,
      prons: plan === 'free' ? [] : prons(c.body),
      beforeSynthesis: async (minutes) => { await consume(c.user.id, plan, 'server_tts_minutes', minutes); },
    });
    return { jobId };
  } },
  'GET /v1/jobs': { auth: true, run: (c) => jobStatus(c.user.id, c.query.get('id') ?? '') },

  'POST /v1/ai/quiz': { auth: true, run: (c) => {
    const count = Math.min(15, Math.max(3, Number(c.body.count ?? 8)));
    const sectionId = typeof c.body.sectionId === 'string' ? c.body.sectionId : undefined;
    const cards = c.body.kind === 'flashcards';
    return aiRun(c, 'quizzes', cards ? 'flashcards' : 'quiz', async (ai, doc) => (cards ? { cards: await flashcards(ai, doc, { sectionId, count }) } : { questions: await quiz(ai, doc, { sectionId, count }) }));
  } },
};

const tokenCache = new Map<string, { id: string; exp: number }>();
async function authenticate(req: IncomingMessage): Promise<{ id: string }> {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) throw new HttpError(401, 'unauthorized', 'Sign in to use this.');
  const hit = tokenCache.get(m[1]);
  if (hit && hit.exp > Date.now()) return { id: hit.id };
  const u = await getUser(m[1]);
  if (!u) throw new HttpError(401, 'unauthorized', 'Your session has expired. Sign in again.');
  tokenCache.set(m[1], { id: u.id, exp: Date.now() + 60_000 });
  if (tokenCache.size > 2000) tokenCache.clear();
  return { id: u.id };
}

async function readBody(req: IncomingMessage, max = 2_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new HttpError(413, 'too_large', 'Request is too large.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const o = req.headers.origin;
  if (o && (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method === 'POST' && url.pathname === '/webhooks/lemonsqueezy') {
      const raw = await readBody(req);
      const out = await processWebhook(raw, req.headers['x-signature'] as string | undefined);
      res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.status === 200 ? { ok: true, duplicate: out.result.duplicate } : { error: out.error }));
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; }
    const user = route.auth ? await authenticate(req) : { id: '' };
    let body: Json = {};
    if (req.method === 'POST') { try { body = JSON.parse((await readBody(req)) || '{}') as Json; } catch (e) { if (e instanceof HttpError) throw e; throw bad('Body must be JSON.'); } }
    let planP: Promise<Plan> | null = null;
    const out = await route.run({ user, body, query: url.searchParams, plan: () => (planP ??= getPlan(user.id)) });
    if (out && typeof out === 'object' && '__binary' in out) {
      const b = out as { __binary: Buffer; type: string };
      res.writeHead(200, { 'Content-Type': b.type, 'Content-Length': b.__binary.length }).end(b.__binary);
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  } catch (e) {
    if (e instanceof HttpError) { res.writeHead(e.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.code, message: e.message })); return; }
    console.error(`${req.method} ${url.pathname} failed`, e);
    report(e, `${req.method} ${url.pathname}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: 'Something went wrong on our side. Try again in a moment.' }));
  }
}).listen(config.port, () => console.log(`earshelf api listening on ${config.port}`));

process.on('uncaughtException', (e) => { console.error('uncaught', e); report(e, 'uncaughtException'); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); report(e, 'unhandledRejection'); });
