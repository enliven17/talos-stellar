"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { VALID_SCOPES } from "@/lib/api-scopes";
import { createApiKeyOwnerMessage } from "@/lib/api-key-owner-message";

interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ScopedApiKeysPanelProps {
  talosId: string;
  address: string;
  signMessage: (message: string) => Promise<string>;
}

function displayDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function ScopedApiKeysPanel({
  talosId,
  address,
  signMessage,
}: ScopedApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [createdKey, setCreatedKey] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  const ownerHeaders = useCallback(async (method: string): Promise<Record<string, string>> => {
    const message = createApiKeyOwnerMessage(talosId, method);
    const signature = await signMessage(message);
    return {
      "x-talos-owner-address": address,
      "x-talos-owner-message": message,
      "x-talos-owner-signature": signature,
    };
  }, [address, signMessage, talosId]);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const headers = await ownerHeaders("GET");
      const response = await fetch(`/api/talos/${talosId}/api-keys`, { headers, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load API keys");
      setKeys(data.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load API keys");
    } finally {
      setLoading(false);
    }
  }, [ownerHeaders, talosId]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const createKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || selectedScopes.length === 0) return;
    setSaving(true);
    setError("");
    try {
      const headers = await ownerHeaders("POST");
      const response = await fetch(`/api/talos/${talosId}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ name: name.trim(), scopes: selectedScopes }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create API key");
      setCreatedKey(data.apiKey);
      setCopyMessage("");
      setKeys((current) => [{
        id: data.id,
        name: data.name,
        scopes: data.scopes,
        status: data.status,
        createdAt: data.createdAt,
        lastUsedAt: null,
      }, ...current]);
      setName("");
      setSelectedScopes([]);
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create API key");
    } finally {
      setSaving(false);
    }
  };

  const revokeKey = async (keyId: string) => {
    setError("");
    try {
      const headers = await ownerHeaders("DELETE");
      const response = await fetch(`/api/talos/${talosId}/api-keys/${keyId}`, {
        method: "DELETE",
        headers,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not revoke API key");
      setKeys((current) => current.map((key) =>
        key.id === keyId ? { ...key, status: "revoked" } : key
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke API key");
    }
  };

  return (
    <section aria-label="Scoped API keys" className="bg-surface border border-border p-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-sm font-bold text-foreground">Scoped API keys</h2>
          <p className="text-xs text-muted mt-1">Create keys with only the access your agent needs.</p>
        </div>
        <button
          type="button"
          onClick={() => { setCreatedKey(""); setError(""); setDialogOpen(true); }}
          className="shrink-0 border border-accent px-3 py-2 text-xs text-accent hover:bg-accent hover:text-background transition-colors"
        >
          Create key
        </button>
      </div>

      {error && <p role="alert" className="text-sm text-red-500 mb-4">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted">No scoped API keys yet.</p>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <div key={key.id} className="border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{key.name}</p>
                  <p className="text-xs text-muted mt-1">{key.scopes.join(", ")}</p>
                  <p className="text-xs text-muted mt-2">
                    Created {displayDate(key.createdAt)} · Last used {displayDate(key.lastUsedAt)}
                  </p>
                </div>
                {key.status === "active" ? (
                  <button
                    type="button"
                    onClick={() => void revokeKey(key.id)}
                    className="text-xs text-red-500 hover:text-red-400"
                  >
                    Revoke
                  </button>
                ) : (
                  <span className="text-xs text-muted">Revoked</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="Close create key dialog"
            className="absolute inset-0 bg-black/60"
            onClick={() => setDialogOpen(false)}
          />
          <form
            onSubmit={createKey}
            aria-label="Create scoped API key"
            className="relative bg-background border border-border w-full max-w-lg max-h-[90vh] overflow-y-auto mx-4 p-6"
          >
            <h3 className="text-sm font-bold text-accent mb-5">Create scoped API key</h3>
            <label className="block text-xs text-muted mb-2" htmlFor="api-key-name">Name</label>
            <input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
              className="w-full bg-surface border border-border px-3 py-2 text-sm text-foreground mb-5"
              placeholder="Agent runner"
            />
            <fieldset className="space-y-2 mb-6">
              <legend className="text-xs text-muted mb-3">Scopes</legend>
              {VALID_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope)}
                    onChange={(event) => setSelectedScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((value) => value !== scope)
                    )}
                  />
                  <span>{scope}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setDialogOpen(false)} className="px-4 py-2 text-xs text-muted">
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || selectedScopes.length === 0}
                className="bg-accent text-background px-4 py-2 text-xs disabled:opacity-50"
              >
                {saving ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        </div>
      )}

      {createdKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" />
          <div role="dialog" aria-modal="true" aria-labelledby="created-api-key-title" className="relative bg-background border border-border w-full max-w-lg mx-4 p-6">
            <h3 id="created-api-key-title" className="text-sm font-bold text-accent mb-2">API key created</h3>
            <p className="text-xs text-muted mb-4">Copy this key now. It will not be shown again.</p>
            <code data-testid="created-api-key" className="block break-all bg-surface border border-border p-3 text-xs text-foreground mb-5">
              {createdKey}
            </code>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(createdKey);
                    setCopyMessage("Copied.");
                  } catch {
                    setCopyMessage("Copy failed. Select the key above and copy it manually.");
                  }
                }}
                className="border border-border px-4 py-2 text-xs text-foreground"
              >
                Copy key
              </button>
              <button
                type="button"
                onClick={() => setCreatedKey("")}
                className="bg-accent text-background px-4 py-2 text-xs"
              >
                Done
              </button>
            </div>
            {copyMessage && <p role="status" className="text-xs text-muted mt-3">{copyMessage}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
