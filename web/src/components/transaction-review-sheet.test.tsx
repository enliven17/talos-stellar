import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TransactionReviewSheet,
  type TransactionPayload,
} from "./transaction-review-sheet";

const live = (overrides: Partial<TransactionPayload> = {}): TransactionPayload => ({
  amount: "12.34",
  destination: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234",
  network: "testnet",
  ...overrides,
});

describe("TransactionReviewSheet", () => {
  it("renders exact amount, destination, and network from the payload", () => {
    render(
      <TransactionReviewSheet
        open
        title="Buy PULSE tokens"
        payload={live()}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("tx-review-amount").textContent).toContain("12.34 USDC");
    expect(screen.getByTestId("tx-review-destination").textContent).toContain("GABCDE");
    expect(screen.getByTestId("tx-review-destination").textContent).toContain("VWXYZ234");
    expect(screen.getByTestId("tx-review-network").textContent).toBe("Testnet");
  });

  it("renders unavailable for missing payload fields rather than fabricating values", () => {
    render(
      <TransactionReviewSheet
        open
        title="Approve transfer"
        payload={{ amount: null, destination: null, network: null }}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("tx-review-amount").textContent).toBe("unavailable");
    expect(screen.getByTestId("tx-review-destination").textContent).toBe("unavailable");
    expect(screen.getByTestId("tx-review-network").textContent).toBe("unavailable");
    expect((screen.getByTestId("tx-review-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalidates the sheet when the payload amount changes mid-review", () => {
    const onDismiss = vi.fn();
    const onInvalidate = vi.fn();
    const { rerender } = render(
      <TransactionReviewSheet
        open
        title="Buy PULSE tokens"
        payload={live()}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={onDismiss}
        onInvalidate={onInvalidate}
      />,
    );
    act(() => {
      rerender(
        <TransactionReviewSheet
          open
          title="Buy PULSE tokens"
          payload={live({ amount: "99.00" })}
          expectedNetwork="testnet"
          onConfirm={() => {}}
          onDismiss={onDismiss}
          onInvalidate={onInvalidate}
        />,
      );
    });
    expect(onInvalidate).toHaveBeenCalledWith("amount");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("invalidates the sheet when the destination changes mid-review", () => {
    const onDismiss = vi.fn();
    const onInvalidate = vi.fn();
    const { rerender } = render(
      <TransactionReviewSheet
        open
        title="Buy PULSE tokens"
        payload={live()}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={onDismiss}
        onInvalidate={onInvalidate}
      />,
    );
    act(() => {
      rerender(
        <TransactionReviewSheet
          open
          title="Buy PULSE tokens"
          payload={live({ destination: "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" })}
          expectedNetwork="testnet"
          onConfirm={() => {}}
          onDismiss={onDismiss}
          onInvalidate={onInvalidate}
        />,
      );
    });
    expect(onInvalidate).toHaveBeenCalledWith("destination");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("invalidates the sheet when the network changes mid-review", () => {
    const onDismiss = vi.fn();
    const onInvalidate = vi.fn();
    const { rerender } = render(
      <TransactionReviewSheet
        open
        title="Buy PULSE tokens"
        payload={live()}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={onDismiss}
        onInvalidate={onInvalidate}
      />,
    );
    act(() => {
      rerender(
        <TransactionReviewSheet
          open
          title="Buy PULSE tokens"
          payload={live({ network: "mainnet" })}
          expectedNetwork="testnet"
          onConfirm={() => {}}
          onDismiss={onDismiss}
          onInvalidate={onInvalidate}
        />,
      );
    });
    expect(onInvalidate).toHaveBeenCalledWith("network");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("blocks approval and shows a warning on network mismatch without invalidating", () => {
    render(
      <TransactionReviewSheet
        open
        title="Buy PULSE tokens"
        payload={live({ network: "mainnet" })}
        expectedNetwork="testnet"
        onConfirm={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("tx-review-network-mismatch").textContent).toContain("Mainnet");
    expect(screen.getByTestId("tx-review-network-mismatch").textContent).toContain("Testnet");
    expect((screen.getByTestId("tx-review-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});
