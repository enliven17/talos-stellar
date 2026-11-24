// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const ownerMessage = "talos:talos-1:financial-statement:GET:1763904000000";
const { signOwnerProofMock } = vi.hoisted(() => ({ signOwnerProofMock: vi.fn() }));

vi.mock("../src/lib/owner-proof-signer", () => ({
  signOwnerProof: signOwnerProofMock,
}));

import { FinancialStatementButton } from "../src/components/financial-statement-button";

describe("FinancialStatementButton", () => {
  const createObjectURL = vi.fn(() => "blob:statement");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    signOwnerProofMock.mockResolvedValue({
      message: "talos:talos-1:financial-statement:GET:1763904000000",
      signature: "c2lnbmF0dXJl",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(["statement"], { type: "application/json" })),
    }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is hidden for non-owners", () => {
    render(<FinancialStatementButton talosId="talos-1" ownerKeys={["GCREATOR"]} address="GOTHER" />);
    expect(screen.queryByTestId("financial-statement-button-json")).toBeNull();
  });

  it("signs a resource-specific proof and downloads the JSON statement", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
    render(<FinancialStatementButton talosId="talos-1" ownerKeys={["GCREATOR"]} address="GCREATOR" />);

    fireEvent.click(screen.getByTestId("financial-statement-button-json"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("/api/talos/talos-1/financial-statement?format=json");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-talos-owner-address"]).toBe("GCREATOR");
    expect(headers["x-talos-owner-message"]).toBe(ownerMessage);
    expect(headers["x-talos-owner-signature"]).toBe("c2lnbmF0dXJl");
    expect(signOwnerProofMock).toHaveBeenCalledWith("talos-1", "financial-statement", "GET");
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:statement");
    vi.useRealTimers();
  });

  it("requests CSV when the CSV control is clicked", async () => {
    render(<FinancialStatementButton talosId="talos-1" ownerKeys={["GCREATOR"]} address="GCREATOR" />);

    fireEvent.click(screen.getByTestId("financial-statement-button-csv"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("format=csv");
  });
});
