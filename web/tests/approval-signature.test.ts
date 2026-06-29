import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../src/app/api/talos/[id]/approvals/[approvalId]/route";
import { tlsApprovals, tlsPatrons, tlsTalos } from "../src/db/schema";

const mocks = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockVerifySignature: vi.fn(),
  mockRecordApprovalOnChain: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: any[]) => mocks.mockSelect(...args),
    update: (...args: any[]) => mocks.mockUpdate(...args),
  },
}));

vi.mock("@/lib/stellar", () => ({
  recordApprovalOnChain: (...args: any[]) => mocks.mockRecordApprovalOnChain(...args),
  verifyStellarSignature: (...args: any[]) => mocks.mockVerifySignature(...args),
}));

describe("PATCH /api/talos/:id/approvals/:approvalId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockVerifySignature.mockResolvedValue(true);
    mocks.mockRecordApprovalOnChain.mockResolvedValue({ txHash: "tx-123" });
  });

  it("approves the request when the patron signature is valid", async () => {
    const approval = { id: "approval-1", talosId: "talos-1", status: "pending" };
    const patron = { talosId: "talos-1", stellarPublicKey: "GABC1234567890", status: "active" };

    mocks.mockSelect.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === tlsTalos) return [{ id: "talos-1" }];
            if (table === tlsApprovals) return [approval];
            if (table === tlsPatrons) return [patron];
            return [];
          },
        }),
      }),
    }));

    mocks.mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: async () => [{ ...approval, status: "approved", decidedBy: patron.stellarPublicKey, txHash: "tx-123" }],
        }),
      }),
    });

    const request = new Request("http://localhost/api/talos/talos-1/approvals/approval-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "approved",
        decidedBy: patron.stellarPublicKey,
        signature: "sig",
        message: "decision-message",
      }),
    });

    const response = await PATCH(request as any, {
      params: Promise.resolve({ id: "talos-1", approvalId: "approval-1" }),
    } as any);

    expect(response.status).toBe(200);
    expect(mocks.mockVerifySignature).toHaveBeenCalledWith(
      patron.stellarPublicKey,
      "decision-message",
      "sig"
    );
  });

  it("rejects the request when no active patron matches the supplied public key", async () => {
    mocks.mockSelect.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === tlsTalos) return [{ id: "talos-1" }];
            if (table === tlsApprovals) return [{ id: "approval-1", talosId: "talos-1", status: "pending" }];
            if (table === tlsPatrons) return [];
            return [];
          },
        }),
      }),
    }));

    const request = new Request("http://localhost/api/talos/talos-1/approvals/approval-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "approved",
        decidedBy: "GABC1234567890",
        signature: "sig",
        message: "decision-message",
      }),
    });

    const response = await PATCH(request as any, {
      params: Promise.resolve({ id: "talos-1", approvalId: "approval-1" }),
    } as any);

    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain("active Patrons");
    expect(mocks.mockVerifySignature).not.toHaveBeenCalled();
  });
});
