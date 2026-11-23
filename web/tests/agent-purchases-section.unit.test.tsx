import "./setup-jsdom";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import {
  AgentPurchasesSection,
  type Purchase,
} from "@/components/agent-purchases-section";

function makePurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: "job-1",
    providerId: "seller-1",
    providerName: "Seller Agent",
    serviceName: "Market Analysis",
    status: "completed",
    price: 12.5,
    txHash: "abc123",
    hasResult: true,
    resultUrl: "/api/jobs/job-1/result",
    createdAt: "2026-03-30T10:00:00.000Z",
    updatedAt: "2026-03-30T10:05:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const defaultProps = {
  talosId: "agent-1",
  isOwner: true,
  address: "GWALLET",
  signMessage: vi.fn(async () => "signature"),
};

describe("AgentPurchasesSection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("prompts to connect when no wallet is present", () => {
    const connect = vi.fn();
    render(
      <AgentPurchasesSection {...defaultProps} address={null} isOwner={false} connect={connect} />,
    );

    expect(screen.getByTestId("purchases-connect")).toBeTruthy();
    fireEvent.click(screen.getByText("Connect Wallet"));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("locks the section for non-owners", () => {
    render(<AgentPurchasesSection {...defaultProps} isOwner={false} />);

    expect(screen.getByTestId("purchases-locked")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the owner's purchases with provider, service, price, status and result link", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ purchases: [makePurchase()], nextCursor: null }),
    );

    render(<AgentPurchasesSection {...defaultProps} />);

    expect(await screen.findByText("Market Analysis")).toBeTruthy();
    expect(screen.getByText("Seller Agent")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();

    const resultLink = screen.getByText(/View result/).closest("a") as HTMLAnchorElement;
    expect(resultLink.getAttribute("href")).toBe("/api/jobs/job-1/result");

    const providerLink = screen.getByText("Seller Agent").closest("a") as HTMLAnchorElement;
    expect(providerLink.getAttribute("href")).toBe("/agents/seller-1");
  });

  it("shows an empty state when the owner has no purchases", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ purchases: [], nextCursor: null }));

    render(<AgentPurchasesSection {...defaultProps} />);

    expect(await screen.findByTestId("purchases-empty")).toBeTruthy();
  });

  it("reuses the retry affordance for failed purchases", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        purchases: [makePurchase({ status: "failed", hasResult: false })],
        nextCursor: null,
      }),
    );

    render(<AgentPurchasesSection {...defaultProps} />);

    expect(await screen.findByText("Retry purchase")).toBeTruthy();
    expect(screen.getByText("[FAILED]")).toBeTruthy();
  });

  it("loads the next page with the returned cursor", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ purchases: [makePurchase()], nextCursor: "cursor-1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          purchases: [makePurchase({ id: "job-2", serviceName: "Risk Review" })],
          nextCursor: null,
        }),
      );

    render(<AgentPurchasesSection {...defaultProps} />);

    const loadMore = await screen.findByText("Load more");
    fireEvent.click(loadMore);

    expect(await screen.findByText("Risk Review")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-1");
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("surfaces a load error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: "Forbidden" }, false, 403),
    );

    render(<AgentPurchasesSection {...defaultProps} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Forbidden")).toBeTruthy();
  });
});
