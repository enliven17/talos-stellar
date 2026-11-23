import { describe, expect, it } from "vitest";
import {
  evaluateLifecycleChecklist,
  LifecycleError,
  type LifecycleActor,
} from "../src/lib/governance/lifecycle";

const OWNER_ACTOR: LifecycleActor = {
  id: "GAOWNER1234567890123456789012345678901234567890123456789012",
  roles: ["creator", "operator"],
};

const NON_OWNER_ACTOR: LifecycleActor = {
  id: "GAVIEWER123456789012345678901234567890123456789012345678901",
  roles: [],
};

describe("evaluateLifecycleChecklist", () => {
  it("evaluates a clean, retirement-ready paused agent", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "paused",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 0,
      hasWallet: true,
    });

    expect(checklist.talosId).toBe("agent_1");
    expect(checklist.state).toBe("paused");
    expect(checklist.legacyStatus).toBe("Paused");
    expect(checklist.isOwner).toBe(true);
    expect(checklist.canRetire).toBe(true);

    const jobsObligation = checklist.obligations.find((o) => o.id === "in_flight_jobs");
    expect(jobsObligation).toBeDefined();
    expect(jobsObligation?.satisfied).toBe(true);
    expect(jobsObligation?.blocking).toBe(false);
    expect(jobsObligation?.count).toBe(0);

    const serviceObligation = checklist.obligations.find((o) => o.id === "service_availability");
    expect(serviceObligation?.satisfied).toBe(true);
    expect(serviceObligation?.blocking).toBe(false);

    const retireAction = checklist.allowedNextActions.find((a) => a.action === "retire");
    expect(retireAction).toBeDefined();
    expect(retireAction?.enabled).toBe(true);
    expect(retireAction?.blockingObligationIds).toEqual([]);
  });

  it("blocks retirement when in-flight commerce jobs exist", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "paused",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 3,
      pendingProposalsCount: 0,
      hasWallet: true,
    });

    expect(checklist.canRetire).toBe(false);

    const jobsObligation = checklist.obligations.find((o) => o.id === "in_flight_jobs");
    expect(jobsObligation?.satisfied).toBe(false);
    expect(jobsObligation?.blocking).toBe(true);
    expect(jobsObligation?.count).toBe(3);
    expect(jobsObligation?.description).toContain("3 in-flight job(s) must drain");

    const retireAction = checklist.allowedNextActions.find((a) => a.action === "retire");
    expect(retireAction?.enabled).toBe(false);
    expect(retireAction?.blockingObligationIds).toContain("in_flight_jobs");
  });

  it("blocks retirement when agent is active and online", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "active",
      actor: OWNER_ACTOR,
      agentOnline: true,
      inFlightJobs: 0,
      pendingProposalsCount: 0,
      hasWallet: true,
    });

    expect(checklist.canRetire).toBe(false);

    const serviceObligation = checklist.obligations.find((o) => o.id === "service_availability");
    expect(serviceObligation?.satisfied).toBe(false);
    expect(serviceObligation?.blocking).toBe(true);

    // Pause action should be available to stop intake
    const pauseAction = checklist.allowedNextActions.find((a) => a.action === "pause");
    expect(pauseAction?.enabled).toBe(true);

    const retireAction = checklist.allowedNextActions.find((a) => a.action === "retire");
    expect(retireAction?.enabled).toBe(false);
    expect(retireAction?.blockingObligationIds).toContain("service_availability");
  });

  it("denies owner actions when viewer is unauthorized", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "active",
      actor: NON_OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 0,
      hasWallet: true,
    });

    expect(checklist.isOwner).toBe(false);
    expect(checklist.canRetire).toBe(false);

    const authObligation = checklist.obligations.find((o) => o.id === "owner_authorization");
    expect(authObligation?.satisfied).toBe(false);
    expect(authObligation?.blocking).toBe(true);

    // Actions should be blocked by owner authorization
    for (const action of checklist.allowedNextActions) {
      expect(action.enabled).toBe(false);
      expect(action.blockingObligationIds).toContain("owner_authorization");
    }
  });

  it("treats retired state as terminal with no next actions", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "retired",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 0,
      hasWallet: true,
      retiredAt: new Date().toISOString(),
    });

    expect(checklist.state).toBe("retired");
    expect(checklist.legacyStatus).toBe("Retired");
    expect(checklist.canRetire).toBe(false);
    expect(checklist.allowedNextActions).toEqual([]);

    for (const obligation of checklist.obligations) {
      expect(obligation.blocking).toBe(false);
    }
  });

  it("handles proposed state requiring governance approval before activation", () => {
    const unapprovedChecklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "proposed",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 1,
      hasWallet: true,
      hasApprovedProposal: false,
    });

    const govObligation = unapprovedChecklist.obligations.find(
      (o) => o.id === "governance_approval"
    );
    expect(govObligation?.satisfied).toBe(false);
    expect(govObligation?.blocking).toBe(true);

    const activateAction = unapprovedChecklist.allowedNextActions.find(
      (a) => a.action === "activate"
    );
    expect(activateAction?.enabled).toBe(false);
    expect(activateAction?.blockingObligationIds).toContain("governance_approval");

    // Once approved, activate becomes enabled
    const approvedChecklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "proposed",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 1,
      hasWallet: true,
      hasApprovedProposal: true,
    });

    const approvedGovObligation = approvedChecklist.obligations.find(
      (o) => o.id === "governance_approval"
    );
    expect(approvedGovObligation?.satisfied).toBe(true);
    expect(approvedGovObligation?.blocking).toBe(false);

    const approvedActivateAction = approvedChecklist.allowedNextActions.find(
      (a) => a.action === "activate"
    );
    expect(approvedActivateAction?.enabled).toBe(true);
  });

  it("handles failed state and offers recovery action", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "failed",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 0,
      pendingProposalsCount: 0,
      hasWallet: true,
    });

    const recoverAction = checklist.allowedNextActions.find((a) => a.action === "recover");
    expect(recoverAction).toBeDefined();
    expect(recoverAction?.enabled).toBe(true);
  });

  it("throws LifecycleError for an unknown lifecycle state", () => {
    expect(() =>
      evaluateLifecycleChecklist({
        talosId: "agent_1",
        state: "nonexistent_state" as any,
        actor: OWNER_ACTOR,
        agentOnline: false,
        inFlightJobs: 0,
        pendingProposalsCount: 0,
        hasWallet: true,
      })
    ).toThrowError(LifecycleError);
  });

  it("preserves private financial details by exposing only counts and public status", () => {
    const checklist = evaluateLifecycleChecklist({
      talosId: "agent_1",
      state: "paused",
      actor: OWNER_ACTOR,
      agentOnline: false,
      inFlightJobs: 5,
      pendingProposalsCount: 2,
      hasWallet: true,
    });

    const stringified = JSON.stringify(checklist);
    // Ensure no private key, seed, secret, or financial transaction data is leaked
    expect(stringified).not.toContain("secret");
    expect(stringified).not.toContain("seed");
    expect(stringified).not.toContain("privateKey");
    expect(stringified).not.toContain("apiKey");
    expect(stringified).not.toContain("token");
    expect(checklist.obligations.find((o) => o.id === "in_flight_jobs")?.count).toBe(5);
    expect(checklist.obligations.find((o) => o.id === "governance_approval")?.count).toBe(2);
  });
});
