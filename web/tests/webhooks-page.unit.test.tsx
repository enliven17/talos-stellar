import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OneTimeSecretDialog,
  WebhooksClient,
  initialWebhookPageState,
  webhookPageReducer,
} from "@/app/webhooks/webhooks-client";
import {
  WEBHOOK_EVENT_TYPE_PRESETS,
  WebhookApiError,
  createWebhookSubscription,
  deleteWebhookSubscription,
  generateWebhookSecret,
  listRecentWebhookDeliveries,
  listWebhookSubscriptions,
  rotateWebhookSubscriptionSecret,
  type WebhookSubscription,
} from "@/app/webhooks/webhook-api";

const subscription: WebhookSubscription = {
  id: "sub_1",
  url: "https://example.com/hooks/talos",
  eventTypes: ["activity.post", "revenue.recorded"],
  description: "Treasury alerts",
  active: true,
  signatureVersion: 1,
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-01-02T03:04:05.000Z",
};

const revealedSecret = {
  subscriptionId: "sub_1",
  url: subscription.url,
  secret: "whsec_plaintext_secret_value",
  reason: "created" as const,
};

function stubFetch(...responses: Response[]) {
  const mock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => responses.shift() ?? new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Awaits a request expected to fail and returns its WebhookApiError. */
async function captureError(request: Promise<unknown>): Promise<WebhookApiError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof WebhookApiError) return error;
    throw error;
  }
  throw new Error("Expected the request to be rejected.");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Page reducer ─────────────────────────────────────────────────

describe("webhookPageReducer", () => {
  it("stores loaded subscriptions and drops a deleted one", () => {
    const loaded = webhookPageReducer(initialWebhookPageState, {
      type: "subscriptions-loaded",
      subscriptions: [subscription],
    });
    expect(loaded.subscriptions).toEqual([subscription]);

    const deleted = webhookPageReducer(loaded, {
      type: "subscription-deleted",
      id: subscription.id,
    });
    expect(deleted.subscriptions).toEqual([]);
  });

  it("puts a freshly created subscription at the head of the list", () => {
    const existing = { ...subscription, id: "sub_old", url: "https://old.test" };
    const created = { ...subscription, id: "sub_new" };
    const state = webhookPageReducer(
      { subscriptions: [existing], revealed: null },
      { type: "subscription-created", subscription: created },
    );
    expect(state.subscriptions.map((item) => item.id)).toEqual([
      "sub_new",
      "sub_old",
    ]);
  });

  it("clears the plaintext secret from state once the dialog is dismissed", () => {
    const withSecret = webhookPageReducer(initialWebhookPageState, {
      type: "secret-revealed",
      revealed: revealedSecret,
    });
    expect(withSecret.revealed?.secret).toBe(revealedSecret.secret);

    const dismissed = webhookPageReducer(withSecret, {
      type: "secret-dismissed",
    });
    expect(dismissed.revealed).toBeNull();
    // The plaintext must not survive anywhere in page state.
    expect(JSON.stringify(dismissed)).not.toContain(revealedSecret.secret);
  });

  it("keeps subscriptions untouched when a secret is revealed or dismissed", () => {
    const state = {
      subscriptions: [subscription],
      revealed: null,
    };
    const revealed = webhookPageReducer(state, {
      type: "secret-revealed",
      revealed: revealedSecret,
    });
    expect(revealed.subscriptions).toBe(state.subscriptions);

    const dismissed = webhookPageReducer(revealed, { type: "secret-dismissed" });
    expect(dismissed.subscriptions).toBe(state.subscriptions);
  });
});

// ─── One-time secret dialog ───────────────────────────────────────

describe("OneTimeSecretDialog", () => {
  it("renders nothing when no secret is revealed", () => {
    const markup = renderToStaticMarkup(
      <OneTimeSecretDialog revealed={null} onDismiss={() => {}} />,
    );
    expect(markup).toBe("");
  });

  it("shows the secret exactly once with copy and dismiss controls", () => {
    const markup = renderToStaticMarkup(
      <OneTimeSecretDialog revealed={revealedSecret} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Copy your signing secret now");
    expect(markup).toContain("shown <strong>only once</strong>");
    expect(markup).toContain("X-Webhook-Signature");
    expect(markup).toContain(revealedSecret.secret);
    expect(markup).toContain('data-testid="webhook-copy-secret"');
    expect(markup).toContain('data-testid="webhook-dismiss-secret"');
    expect(markup).not.toContain("more minute(s)");
  });

  it("explains the dual-sign grace window after a rotation", () => {
    const markup = renderToStaticMarkup(
      <OneTimeSecretDialog
        revealed={{
          ...revealedSecret,
          reason: "rotated",
          secret: "whsec_rotated_secret_value",
          graceSeconds: 900,
        }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("New signing secret");
    expect(markup).toContain("15 more minute(s)");
    expect(markup).toContain("whsec_rotated_secret_value");
  });
});

// ─── Page shell ───────────────────────────────────────────────────

describe("WebhooksClient", () => {
  it("renders the API key, create form, and idle/empty states before loading", () => {
    const markup = renderToStaticMarkup(<WebhooksClient />);

    expect(markup).toContain("Webhook subscriptions");
    expect(markup).toContain('data-testid="webhooks-key-form"');
    expect(markup).toContain('data-testid="webhook-create-form"');
    expect(markup).toContain(
      "Enter your API key and load your subscriptions to get started.",
    );
    expect(markup).toContain('data-testid="webhook-deliveries-empty"');
    // No secret is revealed on first paint.
    expect(markup).not.toContain('data-testid="webhook-secret-dialog"');
  });

  it("offers a checkbox per known event type and preselects activity.post", () => {
    const markup = renderToStaticMarkup(<WebhooksClient />);

    for (const type of WEBHOOK_EVENT_TYPE_PRESETS) {
      expect(markup).toContain(`data-testid="webhook-event-${type}"`);
    }
    expect(markup).toMatch(
      /data-testid="webhook-event-activity\.post"[^>]*checked=""/,
    );
    expect(markup).toContain('data-testid="webhook-create-submit"');
  });
});

// ─── Secret generation ────────────────────────────────────────────

describe("generateWebhookSecret", () => {
  it("produces unique whsec_ secrets with 32 random bytes of hex", () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();

    expect(first).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(second).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

// ─── API client ───────────────────────────────────────────────────

describe("webhook API client", () => {
  it("lists subscriptions with a trimmed bearer token", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ data: [subscription], nextCursor: null }),
    );

    await expect(listWebhookSubscriptions(" key_123 ")).resolves.toEqual([
      subscription,
    ]);

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/webhooks/subscriptions?limit=50");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer key_123",
      Accept: "application/json",
    });
    expect(init?.body).toBeUndefined();
  });

  it("lists recent deliveries with the requested limit", async () => {
    const delivery = {
      id: "dlv_1",
      subscriptionId: "sub_1",
      eventType: "activity.post",
      status: "delivered",
      attempts: 1,
      maxAttempts: 5,
      lastStatusCode: 200,
      lastError: null,
      lastAttemptAt: "2026-01-02T03:04:06.000Z",
      nextAttemptAt: null,
      completedAt: "2026-01-02T03:04:06.000Z",
      createdAt: "2026-01-02T03:04:05.000Z",
    };
    const fetchMock = stubFetch(
      jsonResponse({ data: [delivery], nextCursor: null }),
    );

    await expect(
      listRecentWebhookDeliveries("key_123", { limit: 5 }),
    ).resolves.toEqual([delivery]);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/webhooks/deliveries?limit=5",
    );
  });

  it("creates a subscription and returns the record without a secret", async () => {
    const fetchMock = stubFetch(jsonResponse(subscription, 201));

    const created = await createWebhookSubscription("key_123", {
      url: subscription.url,
      secret: "whsec_plaintext_secret_value",
      eventTypes: subscription.eventTypes,
      description: "Treasury alerts",
    });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/webhooks/subscriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      url: subscription.url,
      secret: "whsec_plaintext_secret_value",
      eventTypes: subscription.eventTypes,
      description: "Treasury alerts",
    });
    expect(created).toEqual(subscription);
    expect(JSON.stringify(created)).not.toContain("whsec_");
  });

  it("rotates with generate=true and surfaces the grace window", async () => {
    const rotated = {
      id: "sub_1",
      secret: "whsec_server_generated_value",
      secretRotatedAt: "2026-01-03T00:00:00.000Z",
      previousSecretExpiresAt: "2026-01-03T00:15:00.000Z",
      graceSeconds: 900,
      rotationActive: true,
    };
    const fetchMock = stubFetch(jsonResponse(rotated));

    await expect(
      rotateWebhookSubscriptionSecret("key_123", "sub_1"),
    ).resolves.toEqual(rotated);

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/webhooks/subscriptions/sub_1/rotate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ generate: true });
  });

  it("deletes a subscription", async () => {
    const fetchMock = stubFetch(jsonResponse({ deleted: true, id: "sub_1" }));

    await expect(
      deleteWebhookSubscription("key_123", "sub_1"),
    ).resolves.toBeUndefined();

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/webhooks/subscriptions/sub_1");
    expect(init?.method).toBe("DELETE");
  });

  it("maps API error envelopes to a WebhookApiError", async () => {
    stubFetch(
      jsonResponse(
        {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          requestId: "req_1",
          issues: ["url: Invalid url"],
        },
        400,
      ),
    );

    const error = await captureError(
      createWebhookSubscription("key_123", {
        url: "not-a-url",
        secret: "whsec_plaintext_secret_value",
        eventTypes: ["activity.post"],
      }),
    );

    expect(error).toBeInstanceOf(WebhookApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("Validation failed");
    expect(error.issues).toEqual(["url: Invalid url"]);
  });

  it("surfaces SSRF rejections from the subscription API verbatim", async () => {
    stubFetch(jsonResponse({ error: "Restricted IP address" }, 400));

    const error = await captureError(
      createWebhookSubscription("key_123", {
        url: "http://169.254.169.254/latest/meta-data",
        secret: "whsec_plaintext_secret_value",
        eventTypes: ["activity.post"],
      }),
    );

    expect(error).toBeInstanceOf(WebhookApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("Restricted IP address");
  });

  it("reports plain-text failures and missing keys without leaking internals", async () => {
    stubFetch(new Response("upstream down", { status: 502 }));
    await expect(listWebhookSubscriptions("key_123")).rejects.toMatchObject({
      name: "WebhookApiError",
      status: 502,
      message: "Request failed with status 502",
    });

    const unused = stubFetch();
    await expect(listWebhookSubscriptions("   ")).rejects.toThrow(
      "Enter your TALOS API key first.",
    );
    expect(unused).not.toHaveBeenCalled();
  });
});
