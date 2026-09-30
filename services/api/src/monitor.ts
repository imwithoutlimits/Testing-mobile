import { createReporter } from '../../../packages/core/src/monitor.ts';
import { config } from './config.ts';

export const reporter = createReporter({
  dsn: config.sentryDsn, platform: 'node',
  environment: process.env.RENDER ? 'production' : 'development',
  release: (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || undefined,
});
/** Fire and forget: reporting an error must never cause another one. */
export const report = (error: unknown, where: string, userId?: string) => { void reporter.capture({ error, where, userId }); };
