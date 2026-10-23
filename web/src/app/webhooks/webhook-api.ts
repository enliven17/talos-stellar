/**
 * Browser client for the webhook subscription management endpoints.
 *
 * Wraps the operator-facing API used by `/webhooks`:
 *
 *   GET    /api/webhooks/subscriptions
 *   POST   /api/webhooks/subscriptions
 *   DELETE /api/webhooks/subscriptions/:id
 *   POST   /api/webhooks/subscriptions/:id/rotate
 *   GET    /api/webhooks/deliveries
 *
 * Every call authenticates with the TALOS owner's API key (same Bearer token
 * the REST API accepts). Signing secrets are generated client-side and are only
 * ever held in memory long enough to show them once.
 */

// ─── Domain types ──────────────────────────────────────────────────

export interface WebhookSubscription {
  id: string;
  url: string;
  eventTypes: string[];
  description: string | null;
  active: boolean;
  signatureVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateWebhookSubscriptionInput {
  url: string;
  secret: string;
  eventTypes: string[];
  description?: string;
}

export interface RotateWebhookSecretResult {
  id: string;
  secret?: string;
  secretRotatedAt: string;
  previousSecretExpiresAt: string;
  graceSeconds: number;
  rotationActive: boolean;
}

/**
 * Event types currently emitted by the platform. Values mirror the payloads
 * fired from the activity, approval, revenue and dividend routes.
 */
export const WEBHOOK_EVENT_TYPE_PRESETS = [
  "activity.post",
  "activity.research",
  "activity.reply",
  "activity.commerce",
  "activity.approval",
  "approval.approved",
  "approval.rejected",
  "revenue.recorded",
  "dividend.distributed",
] as const;

// ─── Errors ────────────────────────────────────────────────────────

/**
 * Error raised for any non-2xx response. `message` is safe to render: it is
 * the server's `error`/`message` field (never a stack trace).
 */
export class WebhookApiError extends Error {
  readonly status: number;
  readonly issues: string[];

  constructor(message: string, status: number, issues: string[] = []) {
    super(message);
    this.name = "WebhookApiError";
    this.status = status;
    this.issues = issues;
  }
}

function readIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((issue): issue is string => typeof issue === "string");
}

async function parseErrorResponse(response: Response): Promise<WebhookApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    (typeof record.error === "string" && record.error) ||
    (typeof record.message === "string" && record.message) ||
    `Request failed with status ${response.status}`;

  return new WebhookApiError(message, response.status, readIssues(record.issues));
}

// ─── Low-level request helper ──────────────────────────────────────

async function webhookRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const key = apiKey.trim();
  if (!key) {
    throw new WebhookApiError("Enter your TALOS API key first.", 401);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new WebhookApiError(
      "Network error — could not reach the TALOS API.",
      0,
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new WebhookApiError(
      "The server returned an invalid JSON response.",
      response.status,
    );
  }
}

// ─── Secret generation ────────────────────────────────────────────

/**
 * Generate a signing secret in the same format the API accepts
 * (`whsec_` + 32 random bytes, hex). Uses the browser's CSPRNG.
 */
export function generateWebhookSecret(): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error("Web Crypto is unavailable in this browser.");
  }
  const bytes = new Uint8Array(32);
  webCrypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `whsec_${hex.join("")}`;
}

// ─── Endpoints ────────────────────────────────────────────────────

export async function listWebhookSubscriptions(
  apiKey: string,
  options: { limit?: number } = {},
): Promise<WebhookSubscription[]> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  const body = await webhookRequest<{ data?: WebhookSubscription[] }>(
    apiKey,
    `/api/webhooks/subscriptions?${params.toString()}`,
  );
  return body.data ?? [];
}

export async function listRecentWebhookDeliveries(
  apiKey: string,
  options: { limit?: number } = {},
): Promise<WebhookDelivery[]> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 10) });
  const body = await webhookRequest<{ data?: WebhookDelivery[] }>(
    apiKey,
    `/api/webhooks/deliveries?${params.toString()}`,
  );
  return body.data ?? [];
}

export async function createWebhookSubscription(
  apiKey: string,
  input: CreateWebhookSubscriptionInput,
): Promise<WebhookSubscription> {
  return webhookRequest<WebhookSubscription>(
    apiKey,
    "/api/webhooks/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        secret: input.secret,
        eventTypes: input.eventTypes,
        ...(input.description ? { description: input.description } : {}),
      }),
    },
  );
}

export async function rotateWebhookSubscriptionSecret(
  apiKey: string,
  subscriptionId: string,
  options: { graceSeconds?: number } = {},
): Promise<RotateWebhookSecretResult> {
  return webhookRequest<RotateWebhookSecretResult>(
    apiKey,
    `/api/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}/rotate`,
    {
      method: "POST",
      body: JSON.stringify({
        generate: true,
        ...(options.graceSeconds ? { graceSeconds: options.graceSeconds } : {}),
      }),
    },
  );
}

export async function deleteWebhookSubscription(
  apiKey: string,
  subscriptionId: string,
): Promise<void> {
  await webhookRequest<{ deleted: boolean }>(
    apiKey,
    `/api/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" },
  );
}
