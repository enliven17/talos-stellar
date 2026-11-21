import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,
  beforeSend: (event, hint) => scrubSentryEvent(event, hint) as typeof event,
  beforeSendTransaction: (event, hint) => scrubSentryEvent(event, hint) as typeof event,
});
