import { describe, expect, it, vi } from "vitest";

// The workflow builders are pure, but importing them pulls in the persistence
// module. Stub the boundary so this suite never opens a connection.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  AGENT_LIFECYCLE_STATES,
  LifecycleError,
  allowedActions,
  evaluateTransition,
  failureStateFor,
  toLegacyStatus,
  toLifecycleState,
  type LifecycleActor,
} from "../src/lib/governance/lifecycle";
import {
  assertPrerequisites,
  parseLifecyclePayload,
  type PrerequisiteContext,
} from "../src/lib/governance/payloads";
import { workflowFor, type ProvisioningEffects } from "../src/lib/governance/provisioning";

const GOVERNANCE: LifecycleActor = { id: "GGOV", roles: ["governance"] };
const OPERATOR: LifecycleActor = { id: "GOPS", roles: ["operator"] };
const SYSTEM: LifecycleActor = { id: "system", roles: ["system"] };

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LifecycleError);
    expect((err as LifecycleError).code).toBe(code);
    return err as LifecycleError;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe("lifecycle state machine", () => {
  it("covers every state named in the specification", () => {
    expect([...AGENT_LIFECYCLE_STATES]).toEqual([
      "proposed",
      "provisioning",
      "active",
      "paused",
      "retiring",
      "retired",
      "recovery_pending",
      "failed",
    ]);
  });

  it("advances an approved proposal into provisioning", () => {
    const decision = evaluateTransition({
      action: "activate",
      from: "proposed",
      actor: GOVERNANCE,
      governanceApproved: true,
    });

    expect(decision.to).toBe("provisioning");
    expect(decision.durable).toBe(true);
  });

  it("refuses activation without an approved governance proposal", () => {
    expectCode(
      () => evaluateTransition({ action: "activate", from: "proposed", actor: GOVERNANCE }),
      "LIFECYCLE_APPROVAL_REQUIRED",
    );
  });

  it("refuses an out-of-order transition", () => {
    // pause is only legal from active — never from proposed.
    expectCode(
      () => evaluateTransition({ action: "pause", from: "proposed", actor: OPERATOR }),
      "LIFECYCLE_INVALID_TRANSITION",
    );
  });

  it("refuses an unauthorized actor even when the transition is legal", () => {
    const err = expectCode(
      () =>
        evaluateTransition({
          action: "retire",
          from: "active",
          actor: OPERATOR,
          governanceApproved: true,
        }),
      "LIFECYCLE_UNAUTHORIZED",
    );
    expect(err.details.requiredRoles).toEqual(["governance"]);
    expect(err.status).toBe(403);
  });

  it("treats retired as terminal for every action", () => {
    for (const action of ["activate", "pause", "retire", "recover"] as const) {
      expectCode(
        () =>
          evaluateTransition({
            action,
            from: "retired",
            actor: GOVERNANCE,
            governanceApproved: true,
          }),
        "LIFECYCLE_TERMINAL_STATE",
      );
    }
  });

  it("rejects an unknown action and an unknown state distinctly", () => {
    expectCode(
      () =>
        evaluateTransition({
          action: "explode" as never,
          from: "active",
          actor: GOVERNANCE,
        }),
      "LIFECYCLE_UNKNOWN_ACTION",
    );

    expectCode(
      () =>
        evaluateTransition({
          action: "pause",
          from: "melting" as never,
          actor: OPERATOR,
        }),
      "LIFECYCLE_UNKNOWN_STATE",
    );
  });

  it("lets the system settle provisioning into active but not an operator", () => {
    expect(
      evaluateTransition({ action: "activate", from: "provisioning", actor: SYSTEM }).to,
    ).toBe("active");

    expectCode(
      () => evaluateTransition({ action: "activate", from: "provisioning", actor: OPERATOR }),
      "LIFECYCLE_UNAUTHORIZED",
    );
  });

  it("walks the full recovery path", () => {
    expect(evaluateTransition({ action: "recover", from: "failed", actor: OPERATOR }).to).toBe(
      "recovery_pending",
    );

    const reprovision = evaluateTransition({
      action: "recover",
      from: "recovery_pending",
      actor: GOVERNANCE,
      governanceApproved: true,
    });
    expect(reprovision.to).toBe("provisioning");
    expect(reprovision.durable).toBe(true);
  });

  it("never offers system-only edges as operator actions", () => {
    expect(allowedActions("provisioning", OPERATOR)).toEqual([]);
    expect(allowedActions("active", OPERATOR)).toEqual(["pause"]);
    expect(allowedActions("active", GOVERNANCE).sort()).toEqual(["pause", "retire"]);
  });

  it("maps transient and failure states onto a safe legacy status", () => {
    expect(toLegacyStatus("active")).toBe("Active");
    expect(toLegacyStatus("retired")).toBe("Retired");
    for (const state of ["proposed", "provisioning", "retiring", "recovery_pending", "failed"] as const) {
      expect(toLegacyStatus(state)).toBe("Paused");
    }
  });

  it("reads legacy status values, defaulting unknown ones to active", () => {
    expect(toLifecycleState("Active")).toBe("active");
    expect(toLifecycleState("Paused")).toBe("paused");
    expect(toLifecycleState(null)).toBe("active");
    expect(toLifecycleState("Whatever")).toBe("active");
  });

  it("exposes a failure edge only for in-flight states", () => {
    expect(failureStateFor("provisioning")).toBe("failed");
    expect(() => failureStateFor("active")).toThrow(LifecycleError);
  });
});

describe("governance payloads", () => {
  const validCreate = {
    action: "create",
    payload: {
      name: "Research Bot",
      category: "Research",
      description: "Reads and summarises market research.",
      persona: "A careful analyst that cites its sources.",
      permissions: ["network.http", "commerce.sell"],
      operator: "G" + "A".repeat(55),
      budgets: { approvalThreshold: 10, gtmBudget: 200, monthlyCapUsd: 500 },
      services: [{ serviceName: "research", price: 25 }],
    },
  };

  it("accepts a well-formed create payload and applies defaults", () => {
    const parsed = parseLifecyclePayload(validCreate);
    expect(parsed.action).toBe("create");
    if (parsed.action !== "create") throw new Error("narrowing failed");
    expect(parsed.payload.services[0].fulfillmentMode).toBe("async");
  });

  it("rejects a budget set where auto-approval exceeds the monthly cap", () => {
    const err = expectCode(
      () =>
        parseLifecyclePayload({
          ...validCreate,
          payload: {
            ...validCreate.payload,
            budgets: { approvalThreshold: 900, gtmBudget: 100, monthlyCapUsd: 500 },
          },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );
    expect(JSON.stringify(err.details.issues)).toContain("approvalThreshold");
  });

  it("rejects a non-canonical operator address", () => {
    expectCode(
      () =>
        parseLifecyclePayload({
          ...validCreate,
          payload: { ...validCreate.payload, operator: "not-a-stellar-key" },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );
  });

  it("rejects unknown fields rather than silently ignoring them", () => {
    expectCode(
      () =>
        parseLifecyclePayload({
          ...validCreate,
          payload: { ...validCreate.payload, adminOverride: true },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );
  });

  it("requires explicit confirmation on consequential actions", () => {
    expectCode(
      () =>
        parseLifecyclePayload({
          action: "retire",
          payload: { reason: "sunset", proposalId: "prop_1" },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );

    const ok = parseLifecyclePayload({
      action: "retire",
      payload: { reason: "sunset", proposalId: "prop_1", confirmed: true },
    });
    expect(ok.action).toBe("retire");
  });

  it("bounds the persona and the service list", () => {
    expectCode(
      () =>
        parseLifecyclePayload({
          ...validCreate,
          payload: { ...validCreate.payload, persona: "too short" },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );

    expectCode(
      () =>
        parseLifecyclePayload({
          ...validCreate,
          payload: {
            ...validCreate.payload,
            services: Array.from({ length: 11 }, () => ({ serviceName: "x", price: 1 })),
          },
        }),
      "LIFECYCLE_INVALID_PAYLOAD",
    );
  });

  it("rejects a non-object body and an unknown action", () => {
    expectCode(() => parseLifecyclePayload(null), "LIFECYCLE_INVALID_PAYLOAD");
    expectCode(() => parseLifecyclePayload({ action: "detonate" }), "LIFECYCLE_UNKNOWN_ACTION");
  });
});

describe("prerequisites", () => {
  const ctx: PrerequisiteContext = {
    operator: "G" + "A".repeat(55),
    grantedPermissions: ["wallet.read"],
    hasWallet: true,
    serviceCount: 1,
    inFlightJobs: 0,
  };

  it("refuses services declared without the commerce permission", () => {
    const parsed = parseLifecyclePayload({
      action: "create",
      payload: {
        name: "Bot",
        category: "Research",
        description: "d",
        persona: "A careful analyst that cites its sources.",
        permissions: ["network.http"],
        operator: ctx.operator!,
        budgets: { approvalThreshold: 1, gtmBudget: 1, monthlyCapUsd: 10 },
        services: [{ serviceName: "research", price: 25 }],
      },
    });

    expectCode(() => assertPrerequisites(parsed, ctx), "LIFECYCLE_PREREQUISITE_FAILED");
  });

  it("refuses retirement that would strand in-flight jobs", () => {
    const parsed = parseLifecyclePayload({
      action: "retire",
      payload: { reason: "sunset", proposalId: "p1", confirmed: true, drainJobs: true },
    });

    const err = expectCode(
      () => assertPrerequisites(parsed, { ...ctx, inFlightJobs: 3 }),
      "LIFECYCLE_PREREQUISITE_FAILED",
    );
    expect(err.details.inFlightJobs).toBe(3);
    expect(err.status).toBe(422);
  });

  it("allows retirement that explicitly opts out of draining", () => {
    const parsed = parseLifecyclePayload({
      action: "retire",
      payload: { reason: "sunset", proposalId: "p1", confirmed: true, drainJobs: false },
    });

    expect(() => assertPrerequisites(parsed, { ...ctx, inFlightJobs: 3 })).not.toThrow();
  });

  it("refuses activation for an agent with no operator of record", () => {
    const parsed = parseLifecyclePayload({
      action: "activate",
      payload: { proposalId: "p1", confirmed: true },
    });

    expectCode(
      () => assertPrerequisites(parsed, { ...ctx, operator: null }),
      "LIFECYCLE_PREREQUISITE_FAILED",
    );
  });

  it("refuses a destructive recovery that names no run to unwind", () => {
    const parsed = parseLifecyclePayload({
      action: "recover",
      payload: { reason: "retry", confirmed: true, forceCompensate: true },
    });

    expectCode(() => assertPrerequisites(parsed, ctx), "LIFECYCLE_PREREQUISITE_FAILED");
  });
});

describe("provisioning workflows", () => {
  const noopEffects: ProvisioningEffects = {
    createWallet: async () => ({}),
    releaseWallet: async () => {},
    issueCredentials: async () => ({}),
    revokeCredentials: async () => {},
    registerServices: async () => ({}),
    deregisterServices: async () => {},
    startRuntime: async () => ({}),
    stopRuntime: async () => {},
  };

  it("provisions dependencies before the runtime that needs them", () => {
    const workflow = workflowFor("activate", noopEffects);
    expect(workflow.steps.map((s) => s.name)).toEqual([
      "wallet",
      "credentials",
      "services",
      "runtime",
    ]);
    expect(workflow.successState).toBe("active");
    expect(workflow.failureState).toBe("failed");
  });

  it("tears down in the reverse order it builds up", () => {
    const workflow = workflowFor("retire", noopEffects);
    expect(workflow.steps.map((s) => s.name)).toEqual(["runtime", "services", "credentials"]);
    expect(workflow.successState).toBe("retired");
  });

  it("reuses the activation workflow for recovery", () => {
    const workflow = workflowFor("recover", noopEffects);
    expect(workflow.action).toBe("recover");
    expect(workflow.steps.map((s) => s.name)).toEqual([
      "wallet",
      "credentials",
      "services",
      "runtime",
    ]);
  });

  it("refuses a durable workflow for an inline action", () => {
    expectCode(() => workflowFor("pause", noopEffects), "LIFECYCLE_INVALID_TRANSITION");
  });

  it("does not restart a runtime that governance retired", async () => {
    let restarted = false;
    const workflow = workflowFor("retire", {
      ...noopEffects,
      startRuntime: async () => {
        restarted = true;
        return {};
      },
    });

    const ctx = {
      jobId: "job_1",
      talosId: "talos_1",
      action: "retire" as const,
      idempotencyKey: "job_1:runtime:compensate",
      outputs: {},
      signal: new AbortController().signal,
    };

    // Compensating a retirement must be inert — re-activating would contradict
    // the governance decision that produced the run.
    await workflow.steps[0].compensate(ctx);
    expect(restarted).toBe(false);
  });
});
