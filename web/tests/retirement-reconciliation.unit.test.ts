import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const snapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/governance/payout-obligations", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/governance/payout-obligations")>(
    "../src/lib/governance/payout-obligations",
  );
  return { ...actual, snapshotPayoutObligations: snapshotMock };
});

import { LifecycleError } from "../src/lib/governance/lifecycle";
import {
  RETIREMENT_STEP_NAMES,
  workflowFor,
  type ProvisioningEffects,
  type StepContext,
  type StepRecord,
} from "../src/lib/governance/provisioning";
import {
  enqueueRetirementReconciliation,
  retirementReconciliationKey,
  summarizeRetirementReconciliation,
} from "../src/lib/governance/retirement-reconciliation";

const noopEffects: ProvisioningEffects = {
  createWallet: vi.fn(async () => ({})),
  releaseWallet: vi.fn(async () => {}),
  issueCredentials: vi.fn(async () => ({})),
  revokeCredentials: vi.fn(async () => {}),
  registerServices: vi.fn(async () => ({})),
  deregisterServices: vi.fn(async () => {}),
  startRuntime: vi.fn(async () => ({})),
  stopRuntime: vi.fn(async () => {}),
};

function record(name: string, over: Partial<StepRecord> = {}): StepRecord {
  return {
    name,
    status: "pending",
    attempts: 0,
    idempotencyKey: "job_1:" + name,
    startedAt: null,
    completedAt: null,
    output: null,
    error: null,
    ...over,
  };
}

const allPending = () => RETIREMENT_STEP_NAMES.map((n) => record(n));

function fakeExecutor(opts: { inserted: { id: string }[]; existing: { id: string }[] }) {
  const values = vi.fn();
  const insertChain: any = {
    values: vi.fn((v: unknown) => {
      values(v);
      return insertChain;
    }),
    onConflictDoNothing: vi.fn(() => insertChain),
    returning: vi.fn(async () => opts.inserted),
  };
  const selectChain: any = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn(async () => opts.existing),
  };
  return {
    executor: { insert: vi.fn(() => insertChain), select: vi.fn(() => selectChain) } as any,
    values,
  };
}

describe("retirement workflow", () => {
  it("keeps RETIREMENT_STEP_NAMES in sync with the workflow and snapshots payouts before teardown", () => {
    const names = workflowFor("retire", noopEffects).steps.map((s) => s.name);
    expect(names).toEqual([...RETIREMENT_STEP_NAMES]);
    expect(names.indexOf("payout-obligations")).toBeLessThan(names.indexOf("runtime"));
  });

  it("payout step records the snapshot as its output and has a no-op compensation", async () => {
    const snapshot = { outstanding: { USDC: "12.500000" }, recordCount: 2, source: "tls_dividends" };
    snapshotMock.mockResolvedValueOnce(snapshot);

    const step = workflowFor("retire", noopEffects).steps.find((s) => s.name === "payout-obligations")!;
    const ctx = {
      jobId: "job_1",
      talosId: "t1",
      action: "retire",
      idempotencyKey: "job_1:payout-obligations",
      outputs: {},
      signal: new AbortController().signal,
    } as StepContext;

    await expect(step.run(ctx)).resolves.toEqual(snapshot);
    expect(snapshotMock).toHaveBeenCalledWith("t1");
    await expect(step.compensate(ctx)).resolves.toBeUndefined();
  });

  it("payout step refuses to run when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const step = workflowFor("retire", noopEffects).steps.find((s) => s.name === "payout-obligations")!;
    await expect(
      step.run({ jobId: "j", talosId: "t1", action: "retire", idempotencyKey: "k", outputs: {}, signal: controller.signal } as StepContext),
    ).rejects.toThrow("interrupted");
  });
});

describe("enqueueRetirementReconciliation", () => {
  it("creates a seeded run with the per-agent idempotency key", async () => {
    const { executor, values } = fakeExecutor({ inserted: [{ id: "job_new" }], existing: [] });
    const res = await enqueueRetirementReconciliation(executor, { talosId: "t1", requestedBy: "GABC" });

    expect(res).toEqual({ jobId: "job_new", created: true });
    const v = values.mock.calls[0][0];
    expect(v.action).toBe("retire");
    expect(v.status).toBe("pending");
    expect(v.cursor).toBe(0);
    expect(v.requestedBy).toBe("GABC");
    expect(v.idempotencyKey).toBe(retirementReconciliationKey("t1"));
    expect(v.steps.map((s: StepRecord) => s.name)).toEqual([...RETIREMENT_STEP_NAMES]);
    expect(v.steps.every((s: StepRecord) => s.status === "pending" && s.attempts === 0)).toBe(true);
    expect(v.steps[0].idempotencyKey).toBe(`${v.id}:${RETIREMENT_STEP_NAMES[0]}`);
  });

  it("returns the existing run on conflict instead of creating a second one", async () => {
    const { executor } = fakeExecutor({ inserted: [], existing: [{ id: "job_old" }] });
    const res = await enqueueRetirementReconciliation(executor, { talosId: "t1", requestedBy: "GABC" });
    expect(res).toEqual({ jobId: "job_old", created: false });
  });

  it("fails with LIFECYCLE_CONFLICT when neither an insert nor an existing run is found", async () => {
    const { executor } = fakeExecutor({ inserted: [], existing: [] });
    const err = await enqueueRetirementReconciliation(executor, { talosId: "t1", requestedBy: "GABC" }).catch((e) => e);
    expect(err).toBeInstanceOf(LifecycleError);
    expect(err.code).toBe("LIFECYCLE_CONFLICT");
  });
});

describe("summarizeRetirementReconciliation", () => {
  it("reports every step as remaining for a fresh run", () => {
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "pending", steps: allPending(), completedAt: null });
    expect(s.completedSteps).toEqual([]);
    expect(s.remainingSteps).toEqual([...RETIREMENT_STEP_NAMES]);
    expect(s.failedStep).toBeNull();
    expect(s.outstandingPayouts).toBeNull();
  });

  it("falls back to the full step list when the run has no seeded steps yet", () => {
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "pending", steps: [], completedAt: null });
    expect(s.remainingSteps).toEqual([...RETIREMENT_STEP_NAMES]);
  });

  it("tracks remaining steps and surfaces the recorded payout snapshot", () => {
    const steps = [
      record("drain-jobs", { status: "completed" }),
      record("payout-obligations", {
        status: "completed",
        output: { outstanding: { USDC: "12.500000" }, recordCount: 2, source: "tls_dividends" },
      }),
      record("runtime"),
      record("services"),
      record("credentials"),
    ];
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "running", steps, completedAt: null });
    expect(s.completedSteps).toEqual(["drain-jobs", "payout-obligations"]);
    expect(s.remainingSteps).toEqual(["runtime", "services", "credentials"]);
    expect(s.outstandingPayouts).toEqual({ USDC: "12.500000" });
  });

  it("reports a failed step without exposing its error text", () => {
    const steps = allPending().map((r) =>
      r.name === "services" ? { ...r, status: "failed" as const, attempts: 3, error: "db password leaked" } : r,
    );
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "failed", steps, completedAt: null });
    expect(s.failedStep).toBe("services");
    expect(s.remainingSteps).toContain("services");
    expect(JSON.stringify(s)).not.toContain("leaked");
  });

  it("drops malformed payout amounts rather than reporting them", () => {
    const steps = [
      record("payout-obligations", { status: "completed", output: { outstanding: { USDC: "12.5", XLM: "1e3" } } }),
    ];
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "running", steps, completedAt: null });
    expect(s.outstandingPayouts).toEqual({ USDC: "12.5" });
  });

  it("is empty once the run completed", () => {
    const steps = RETIREMENT_STEP_NAMES.map((n) => record(n, { status: "completed" }));
    const done = new Date("2026-01-01T00:00:00.000Z");
    const s = summarizeRetirementReconciliation({ id: "job_1", status: "completed", steps, completedAt: done });
    expect(s.remainingSteps).toEqual([]);
    expect(s.completedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
