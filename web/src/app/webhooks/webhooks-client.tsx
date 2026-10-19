"use client";

/**
 * Webhook subscription management UI (`/webhooks`).
 *
 * Operators paste their TALOS API key, then create, inspect, rotate and delete
 * webhook subscriptions and review recent delivery attempts.
 *
 * Secret handling: the plaintext signing secret exists only twice — in the
 * create/rotate request body and in the one-time dialog below. It is never
 * written to component state that survives dismissal, never persisted to
 * storage and never re-fetched from the API.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  WEBHOOK_EVENT_TYPE_PRESETS,
  WebhookApiError,
  createWebhookSubscription,
  deleteWebhookSubscription,
  generateWebhookSecret,
  listRecentWebhookDeliveries,
  listWebhookSubscriptions,
  rotateWebhookSubscriptionSecret,
  type WebhookDelivery,
  type WebhookSubscription,
} from "./webhook-api";

// Per-tab key storage. Deliberately separate from the admin pages' key so an
// owner key is never reused against admin APIs.
const STORAGE_KEY = "talos_webhook_api_key";

// ─── Page state ────────────────────────────────────────────────────

export interface RevealedSecret {
  subscriptionId: string;
  url: string;
  secret: string;
  reason: "created" | "rotated";
  graceSeconds?: number;
}

export type WebhookPageAction =
  | { type: "subscriptions-loaded"; subscriptions: WebhookSubscription[] }
  | { type: "subscription-created"; subscription: WebhookSubscription }
  | { type: "subscription-deleted"; id: string }
  | { type: "secret-revealed"; revealed: RevealedSecret }
  | { type: "secret-dismissed" };

export interface WebhookPageState {
  subscriptions: WebhookSubscription[];
  revealed: RevealedSecret | null;
}

export const initialWebhookPageState: WebhookPageState = {
  subscriptions: [],
  revealed: null,
};

/**
 * Pure page reducer. Exported so tests can prove the plaintext secret is
 * dropped on dismissal and never leaks into the subscription list.
 */
export function webhookPageReducer(
  state: WebhookPageState,
  action: WebhookPageAction,
): WebhookPageState {
  switch (action.type) {
    case "subscriptions-loaded":
      return { ...state, subscriptions: action.subscriptions };
    case "subscription-created":
      return {
        ...state,
        subscriptions: [action.subscription, ...state.subscriptions],
      };
    case "subscription-deleted":
      return {
        ...state,
        subscriptions: state.subscriptions.filter(
          (subscription) => subscription.id !== action.id,
        ),
      };
    case "secret-revealed":
      return { ...state, revealed: action.revealed };
    case "secret-dismissed":
      return { ...state, revealed: null };
    default:
      return state;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (error instanceof WebhookApiError) {
    return error.issues.length > 0
      ? `${error.message}: ${error.issues.join(", ")}`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function statusClass(status: string): string {
  if (status === "success" || status === "delivered") return "text-emerald-500";
  if (status === "failed" || status === "dead_letter") return "text-red-500";
  return "text-muted";
}

// ─── One-time secret dialog ────────────────────────────────────────

/**
 * Shows a freshly created/rotated signing secret exactly once. The caller
 * clears `revealed` via `onDismiss`, which removes the plaintext from state.
 */
export function OneTimeSecretDialog({
  revealed,
  onDismiss,
}: {
  revealed: RevealedSecret | null;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const titleId = useId();

  if (!revealed) return null;

  const dismiss = () => {
    // Reset before unmounting so a later secret never inherits "copied".
    setCopyState("idle");
    onDismiss();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      data-testid="webhook-secret-dialog"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl space-y-4 border border-border bg-surface p-6"
        onKeyDown={(event) => {
          if (event.key === "Escape") dismiss();
        }}
      >
        <div>
          <h2 id={titleId} className="text-lg font-bold text-foreground">
            {revealed.reason === "created"
              ? "Copy your signing secret now"
              : "New signing secret"}
          </h2>
          <p className="mt-2 text-sm text-muted">
            This secret is shown <strong>only once</strong> and cannot be
            retrieved later. Store it in your secret manager before closing this
            dialog, then use it to verify the{" "}
            <code className="text-accent">X-Webhook-Signature</code> header on
            incoming deliveries.
          </p>
          {revealed.reason === "rotated" && revealed.graceSeconds ? (
            <p className="mt-2 text-sm text-muted">
              The previous secret keeps signing deliveries for{" "}
              {Math.max(1, Math.round(revealed.graceSeconds / 60))} more
              minute(s), so you can deploy the new one without downtime.
            </p>
          ) : null}
        </div>

        <code
          className="block break-all border border-border bg-background p-3 font-mono text-sm text-foreground select-all"
          data-testid="webhook-secret-value"
        >
          {revealed.secret}
        </code>

        {copyState === "copied" && (
          <p role="status" className="text-sm text-emerald-500">
            Copied to clipboard.
          </p>
        )}
        {copyState === "error" && (
          <p role="alert" className="text-sm text-amber-500">
            Clipboard access was blocked — select the value above and copy it
            manually.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={copy}
            className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90"
            data-testid="webhook-copy-secret"
          >
            Copy secret
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover"
            data-testid="webhook-dismiss-secret"
          >
            I have saved it
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page component ────────────────────────────────────────────────

export function WebhooksClient() {
  const [state, dispatch] = useReducer(
    webhookPageReducer,
    initialWebhookPageState,
  );
  const [apiKey, setApiKey] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<string[]>([
    "activity.post",
  ]);
  const [customTypes, setCustomTypes] = useState<string[]>([]);
  const [customType, setCustomType] = useState("");
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) setApiKey(stored);
    } catch {
      /* sessionStorage may be unavailable (private mode) — ignore. */
    }
  }, []);

  const persistKey = (value: string) => {
    setApiKey(value);
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(async () => {
    if (!apiKey.trim()) {
      setError("Enter your TALOS API key to manage webhook subscriptions.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const [subscriptions, recentDeliveries] = await Promise.all([
        listWebhookSubscriptions(apiKey),
        // Deliveries are supplementary: an empty feed must not hide the list.
        listRecentWebhookDeliveries(apiKey).catch(
          () => [] as WebhookDelivery[],
        ),
      ]);
      dispatch({ type: "subscriptions-loaded", subscriptions });
      setDeliveries(recentDeliveries);
      setLoaded(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  const allEventTypes = useMemo(() => {
    const presets: readonly string[] = WEBHOOK_EVENT_TYPE_PRESETS;
    const extras = customTypes.filter((type) => !presets.includes(type));
    return [...presets, ...extras];
  }, [customTypes]);

  const toggleType = (type: string) => {
    setSelectedTypes((previous) =>
      previous.includes(type)
        ? previous.filter((value) => value !== type)
        : [...previous, type],
    );
  };

  const addCustomType = () => {
    const value = customType.trim();
    if (!value) return;
    setCustomTypes((previous) =>
      previous.includes(value) ? previous : [...previous, value],
    );
    setSelectedTypes((previous) =>
      previous.includes(value) ? previous : [...previous, value],
    );
    setCustomType("");
  };

  const onCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    setNotice(null);

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setCreateError("Enter the HTTPS endpoint that should receive events.");
      return;
    }
    if (selectedTypes.length === 0) {
      setCreateError("Select at least one event type.");
      return;
    }
    if (!apiKey.trim()) {
      setCreateError("Enter your TALOS API key first.");
      return;
    }

    // Generate the secret locally so plaintext never round-trips from the API.
    let secret: string;
    try {
      secret = generateWebhookSecret();
    } catch {
      setCreateError(
        "This browser cannot generate a secure secret. Use a modern browser over HTTPS.",
      );
      return;
    }

    setCreating(true);
    try {
      const created = await createWebhookSubscription(apiKey, {
        url: trimmedUrl,
        secret,
        eventTypes: selectedTypes,
        description: description.trim() || undefined,
      });
      dispatch({ type: "subscription-created", subscription: created });
      dispatch({
        type: "secret-revealed",
        revealed: {
          subscriptionId: created.id,
          url: created.url,
          secret,
          reason: "created",
        },
      });
      setUrl("");
      setDescription("");
      setSelectedTypes(["activity.post"]);
      setLoaded(true);
      setNotice(`Subscription created for ${created.url}.`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const onRotate = async (subscription: WebhookSubscription) => {
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        `Rotate the signing secret for ${subscription.url}? The old secret keeps working during the grace window.`,
      );
    if (!confirmed) return;

    setBusyId(subscription.id);
    setError(null);
    setNotice(null);
    try {
      const result = await rotateWebhookSubscriptionSecret(
        apiKey,
        subscription.id,
      );
      if (!result.secret) {
        setError(
          "Rotation succeeded but the server did not return the new secret.",
        );
        return;
      }
      dispatch({
        type: "secret-revealed",
        revealed: {
          subscriptionId: subscription.id,
          url: subscription.url,
          secret: result.secret,
          reason: "rotated",
          graceSeconds: result.graceSeconds,
        },
      });
      setNotice(
        `Secret rotated for ${subscription.url}. Both secrets sign deliveries for ${Math.max(
          1,
          Math.round(result.graceSeconds / 60),
        )} more minute(s).`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (subscription: WebhookSubscription) => {
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        `Delete the subscription for ${subscription.url}? Deliveries stop immediately.`,
      );
    if (!confirmed) return;

    setBusyId(subscription.id);
    setError(null);
    setNotice(null);
    try {
      await deleteWebhookSubscription(apiKey, subscription.id);
      dispatch({ type: "subscription-deleted", id: subscription.id });
      setDeliveries((previous) =>
        previous.filter(
          (delivery) => delivery.subscriptionId !== subscription.id,
        ),
      );
      setNotice(`Deleted the subscription for ${subscription.url}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          Webhook subscriptions
        </h1>
        <p className="text-sm text-muted mt-1">
          Register HTTPS endpoints that receive signed TALOS events. Secrets are
          generated in your browser, shown once, and never returned by the API.
          Requires your TALOS API key.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
        className="space-y-4 border border-border bg-surface p-4"
        data-testid="webhooks-key-form"
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          TALOS API key
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => persistKey(event.target.value)}
            placeholder="Bearer token value"
            className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
            data-testid="webhooks-api-key"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:opacity-50"
          data-testid="webhooks-load"
        >
          {loading
            ? "Loading…"
            : loaded
              ? "Refresh subscriptions"
              : "Load subscriptions"}
        </button>
      </form>

      {error && (
        <div
          className="border border-red-500/40 bg-red-500/5 text-sm text-red-700 px-4 py-3"
          role="alert"
          data-testid="webhooks-error"
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          className="border border-emerald-500/40 bg-emerald-500/5 text-sm text-emerald-700 px-4 py-3"
          role="status"
          data-testid="webhooks-notice"
        >
          {notice}
        </div>
      )}

      <form
        onSubmit={onCreate}
        className="space-y-4 border border-border bg-surface p-4"
        data-testid="webhook-create-form"
      >
        <h2 className="text-sm font-bold text-foreground">
          Add a subscription
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Callback URL
            <input
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/webhooks/talos"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="webhook-create-url"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Description (optional)
            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. Treasury alerts"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="webhook-create-description"
            />
          </label>
        </div>

        <p className="text-xs text-muted">
          Public HTTPS URLs only — loopback, private ranges and link-local
          addresses are rejected by the API.
        </p>

        <fieldset className="space-y-2">
          <legend className="text-xs text-muted">Event types</legend>
          <div className="flex flex-wrap gap-2">
            {allEventTypes.map((type) => {
              const checked = selectedTypes.includes(type);
              return (
                <label
                  key={type}
                  className={`flex items-center gap-2 border px-2 py-1 text-xs font-mono ${
                    checked
                      ? "border-accent text-accent"
                      : "border-border text-nav-foreground hover:bg-surface-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleType(type)}
                    className="accent-current"
                    data-testid={`webhook-event-${type}`}
                  />
                  {type}
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Custom event type
              <input
                type="text"
                value={customType}
                onChange={(event) => setCustomType(event.target.value)}
                placeholder="e.g. wallet.funded"
                className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
                data-testid="webhook-custom-event-type"
              />
            </label>
            <button
              type="button"
              onClick={addCustomType}
              className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover"
              data-testid="webhook-add-event-type"
            >
              Add event type
            </button>
          </div>
        </fieldset>

        {createError && (
          <div
            className="border border-red-500/40 bg-red-500/5 text-sm text-red-700 px-4 py-3"
            role="alert"
            data-testid="webhook-create-error"
          >
            {createError}
          </div>
        )}

        <button
          type="submit"
          disabled={creating}
          className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:opacity-50"
          data-testid="webhook-create-submit"
        >
          {creating ? "Creating…" : "Create subscription"}
        </button>
      </form>

      <section
        className="space-y-3"
        aria-labelledby="webhook-subscriptions-heading"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="webhook-subscriptions-heading"
            className="text-lg font-bold text-foreground"
          >
            Subscriptions
          </h2>
          <span className="text-xs text-muted">
            {state.subscriptions.length} configured
          </span>
        </div>

        {!loaded && (
          <p className="text-sm text-muted" data-testid="webhooks-idle">
            Enter your API key and load your subscriptions to get started.
          </p>
        )}

        {loaded && state.subscriptions.length === 0 && (
          <p
            className="border border-border bg-surface px-4 py-6 text-sm text-muted"
            data-testid="webhooks-empty"
          >
            No webhook subscriptions yet. Create one above to start receiving
            events.
          </p>
        )}

        {state.subscriptions.length > 0 && (
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-surface border-b border-border text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Endpoint
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Events
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.subscriptions.map((subscription) => (
                  <tr
                    key={subscription.id}
                    className="border-b border-border last:border-b-0"
                    data-testid="webhook-subscription-row"
                  >
                    <td className="px-3 py-3 align-top">
                      <span className="block break-all text-foreground">
                        {subscription.url}
                      </span>
                      {subscription.description && (
                        <span className="mt-1 block text-muted">
                          {subscription.description}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1">
                        {subscription.eventTypes.map((type) => (
                          <span
                            key={type}
                            className="border border-border px-1.5 py-0.5 text-[10px] text-nav-foreground"
                          >
                            {type}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={
                          subscription.active
                            ? "text-emerald-500"
                            : "text-muted"
                        }
                      >
                        {subscription.active ? "active" : "paused"}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top text-muted">
                      {formatTimestamp(subscription.createdAt)}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void onRotate(subscription)}
                          disabled={busyId === subscription.id}
                          className="border border-border px-3 py-1 text-nav-foreground hover:bg-surface-hover disabled:opacity-50"
                          data-testid={`webhook-rotate-${subscription.id}`}
                        >
                          Rotate secret
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(subscription)}
                          disabled={busyId === subscription.id}
                          className="border border-red-500/40 px-3 py-1 text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                          data-testid={`webhook-delete-${subscription.id}`}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="webhook-deliveries-heading">
        <div>
          <h2
            id="webhook-deliveries-heading"
            className="text-lg font-bold text-foreground"
          >
            Recent deliveries
          </h2>
          <p className="mt-1 text-xs text-muted">
            The latest delivery attempts across your subscriptions. HTTP status
            and error text come from the receiving endpoint.
          </p>
        </div>

        {deliveries.length === 0 ? (
          <p
            className="border border-border bg-surface px-4 py-6 text-sm text-muted"
            data-testid="webhook-deliveries-empty"
          >
            {loaded
              ? "No deliveries yet — attempts appear here once an event fires."
              : "Load your subscriptions to see delivery attempts."}
          </p>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-surface border-b border-border text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Time
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Event
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    HTTP
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Last error
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr
                    key={delivery.id}
                    className="border-b border-border last:border-b-0"
                    data-testid="webhook-delivery-row"
                  >
                    <td className="px-3 py-3 align-top text-muted">
                      {formatTimestamp(delivery.createdAt)}
                    </td>
                    <td className="px-3 py-3 align-top text-foreground">
                      {delivery.eventType}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={statusClass(delivery.status)}>
                        {delivery.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top text-muted">
                      {delivery.attempts}/{delivery.maxAttempts}
                    </td>
                    <td className="px-3 py-3 align-top text-muted">
                      {delivery.lastStatusCode ?? "—"}
                    </td>
                    <td className="px-3 py-3 align-top text-muted">
                      <span className="block max-w-xs break-all">
                        {delivery.lastError ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OneTimeSecretDialog
        key={
          state.revealed
            ? `${state.revealed.subscriptionId}:${state.revealed.reason}`
            : "no-secret"
        }
        revealed={state.revealed}
        onDismiss={() => dispatch({ type: "secret-dismissed" })}
      />
    </div>
  );
}
