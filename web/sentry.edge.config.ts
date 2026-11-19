import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend: (event, hint) => scrubSentryEvent(event, hint) as typeof event,
  beforeSendTransaction: (event, hint) => scrubSentryEvent(event, hint) as typeof event,
});
