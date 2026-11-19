import type { Breadcrumb, Event, EventHint } from "@sentry/nextjs";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|session|email|phone|mobile|wallet|address|seed|mnemonic|private[-_]?key|signature|proof|media|content)/i;

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function scrubValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return key?.toLowerCase().includes("url") ? scrubUrl(value) : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, undefined, seen));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, scrubValue(entryValue, entryKey, seen)]));
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubValue(breadcrumb) as Breadcrumb;
}

/** Remove PII and credentials before an event leaves the process for Sentry. */
export function scrubSentryEvent(event: Event, _hint?: EventHint): Event {
  const scrubbed = scrubValue(event) as Event;
  scrubbed.user = undefined;
  if (scrubbed.request) {
    scrubbed.request.headers = undefined;
    scrubbed.request.cookies = undefined;
    // Sentry sends the query string separately from `request.url`, so clearing
    // the URL query alone still leaks query-string PII — drop it entirely.
    scrubbed.request.query_string = undefined;
    if (scrubbed.request.url) scrubbed.request.url = scrubUrl(scrubbed.request.url);
  }
  if (scrubbed.breadcrumbs) scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb);
  return scrubbed;
}

export { REDACTED };
