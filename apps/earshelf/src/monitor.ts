import { createReporter } from '@wells/core';

const reporter = createReporter({
  dsn: import.meta.env.VITE_SENTRY_DSN, platform: 'javascript', environment: import.meta.env.MODE, release: import.meta.env.VITE_RELEASE,
});
let userId: string | undefined;
/** Only an id is ever attached to a report, never an email or document text. */
export const setMonitorUser = (id: string | undefined) => { userId = id; };

const NOISE = /ResizeObserver loop|AbortError|Failed to fetch|NetworkError|Load failed|The operation was aborted/i;
export function reportError(error: unknown, where: string, extra?: Record<string, string | number | boolean>) {
  const msg = error instanceof Error ? error.message : String(error);
  if (NOISE.test(msg) || !reporter.enabled) return;
  void reporter.capture({ error, where, extra, userId });
}

let installed = false;
export function installGlobalHandlers() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'window.error'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'unhandledrejection'));
}
