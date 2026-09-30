/// <reference types="vite/client" />
declare module 'mammoth/mammoth.browser' {
  const mammoth: { convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }> };
  export default mammoth;
}
interface ImportMetaEnv {
  readonly VITE_DEV_PLAN?: 'free' | 'plus' | 'pro';
  readonly VITE_DOCUMENT_WORKER_URL?: string;
  readonly VITE_TTS_WORKER_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_LS_CHECKOUT_PLUS?: string;
  readonly VITE_LS_CHECKOUT_PRO?: string;
  readonly VITE_LS_PORTAL_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_RELEASE?: string;
}
