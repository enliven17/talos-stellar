// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ScopedApiKeysPanel } from "../src/components/scoped-api-keys-panel";

const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ScopedApiKeysPanel", () => {
  const signMessage = vi.fn(async (message: string) => `signature:${message}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    signMessage.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates a scoped key, shows it once, and never logs its value", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ keys: [] }))
      .mockResolvedValueOnce(jsonResponse({
        id: "key-1",
        name: "Runner",
        scopes: ["activity:write"],
        status: "active",
        createdAt: "2026-10-20T12:00:00.000Z",
        apiKey: "tak_one_time_secret",
      }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopedApiKeysPanel talosId="agent-1" address={address} signMessage={signMessage} />);
    await screen.findByText("No scoped API keys yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    const form = screen.getByRole("form", { name: "Create scoped API key" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Runner" } });
    fireEvent.click(within(form).getByLabelText("activity:write"));
    fireEvent.click(within(form).getByRole("button", { name: "Create key" }));

    expect((await screen.findByTestId("created-api-key")).textContent).toBe("tak_one_time_secret");
    expect(screen.getByText("Copy this key now. It will not be shown again.")).toBeTruthy();
    expect(screen.getByText("Runner")).toBeTruthy();
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining("tak_one_time_secret"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, request] = fetchMock.mock.calls[1];
    expect(request.method).toBe("POST");
    expect(request.headers["x-talos-owner-address"]).toBe(address);
    expect(JSON.parse(request.body).scopes).toEqual(["activity:write"]);
    expect(signMessage).toHaveBeenCalledWith(expect.stringMatching(/^talos:agent-1:api-keys:POST:/));
  });

  it("revokes an active key and updates its displayed status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        keys: [{
          id: "key-1",
          name: "Runner",
          scopes: ["wallet:read"],
          status: "active",
          createdAt: "2026-10-20T12:00:00.000Z",
          lastUsedAt: null,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: "API key revoked" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopedApiKeysPanel talosId="agent-1" address={address} signMessage={signMessage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(screen.getByText("Revoked")).toBeTruthy());
    const [, request] = fetchMock.mock.calls[1];
    expect(request.method).toBe("DELETE");
    expect(request.headers["x-talos-owner-address"]).toBe(address);
    expect(signMessage).toHaveBeenCalledWith(expect.stringMatching(/^talos:agent-1:api-keys:DELETE:/));
  });
});
