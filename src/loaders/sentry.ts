/**
 * Sentry error tracking loader for gp_core backend (Story 1.9)
 *
 * Graceful degradation: when SENTRY_DSN is not set, Sentry is skipped silently.
 */

import * as Sentry from "@sentry/node";

export default async function sentryLoader(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    // Graceful degradation — no crash when DSN is absent
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.1,
  });
}
