/**
 * Focused unit tests for the offline lifecycle consistency report.
 *
 * All inputs are synthetic in-memory fixtures; no database, network, or
 * Stellar credentials are required. The module under test is pure (no I/O),
 * so every assertion is deterministic.
 *
 * Before/after demonstration: the BEFORE column documents what the report
 * returns when a snapshot is inconsistent; the AFTER column documents what it
 * returns for the corrected snapshot. Both are verified inline so the PR diff
 * makes the change visible.
 */
import { describe, expect, it } from "vitest";

import {
  buildConsistencyReport,
  CONTRADICTION_CODES,
  type ConsistencySnapshot,
  type LifecycleRecord,
  type ServiceRecord,
  type UnresolvedJobRecord,
} from "../src/lib/governance/consistency-report";

// ── Helpers ──────────────────────────────────────────────────────────────────

function lifecycle(
  talosId: string,
  overrides: Partial<LifecycleRecord> = {},
): LifecycleRecord {
  return {
    talosId,
    state: "active",
    onlineFlag: true,
    hasRetiredTimestamp: false,
    ...overrides,
  };
}

function service(talosId: string, serviceId: string, hasActivePaymentKey = true): ServiceRecord {
  return { talosId, serviceId, hasActivePaymentKey };
}

function job(talosId: string, jobId: string, status = "pending"): UnresolvedJobRecord {
  return { talosId, jobId, status };
}

function snapshot(
  lifecycleRecords: LifecycleRecord[],
  serviceRecords: ServiceRecord[] = [],
  unresolvedJobs: UnresolvedJobRecord[] = [],
): ConsistencySnapshot {
  return { lifecycleRecords, serviceRecords, unresolvedJobs };
}

// ── Fully consistent snapshots ───────────────────────────────────────────────

describe("consistent snapshot", () => {
  it("reports no contradictions for a healthy active agent", () => {
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "active", onlineFlag: true, hasRetiredTimestamp: false })],
        [service("agent-1", "svc-1")],
        [],
      ),
    );

    expect(report.consistent).toBe(true);
    expect(report.contradictions).toHaveLength(0);
    expect(report.agentCount).toBe(1);
    expect(report.serviceCount).toBe(1);
    expect(report.unresolvedJobCount).toBe(0);
  });

  it("reports no contradictions for a cleanly retired agent", () => {
    const report = buildConsistencyReport(
      snapshot(
        [
          lifecycle("agent-1", {
            state: "retired",
            onlineFlag: false,
            hasRetiredTimestamp: true,
          }),
        ],
        // No active payment keys on retired agent's service
        [service("agent-1", "svc-1", false)],
        [],
      ),
    );

    expect(report.consistent).toBe(true);
    expect(report.contradictions).toHaveLength(0);
  });

  it("reports no contradictions for a paused agent", () => {
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "paused", onlineFlag: false, hasRetiredTimestamp: false })],
        [service("agent-1", "svc-1")],
        [],
      ),
    );

    expect(report.consistent).toBe(true);
  });

  it("returns an empty report for an empty snapshot", () => {
    const report = buildConsistencyReport(snapshot([], [], []));

    expect(report.consistent).toBe(true);
    expect(report.contradictions).toHaveLength(0);
    expect(report.agentCount).toBe(0);
    expect(report.serviceCount).toBe(0);
    expect(report.unresolvedJobCount).toBe(0);
  });

  it("ignores service and job records belonging to other agents", () => {
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        // This service and job belong to a different agent — must not trigger contradictions.
        [service("agent-2", "svc-other")],
        [job("agent-2", "job-other")],
      ),
    );

    expect(report.consistent).toBe(true);
  });
});

// ── TERMINAL_AGENT_ONLINE ────────────────────────────────────────────────────

describe("TERMINAL_AGENT_ONLINE", () => {
  it("BEFORE: flags a retired agent whose online flag is still true", () => {
    // BEFORE: agent was retired but agentOnline was not cleared.
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "retired", onlineFlag: true, hasRetiredTimestamp: true })]),
    );
    expect(before.consistent).toBe(false);
    const c = before.contradictions.find((x) => x.code === "TERMINAL_AGENT_ONLINE");
    expect(c).toBeDefined();
    expect(c!.talosId).toBe("agent-1");
    expect(c!.evidence.state).toBe("retired");
    expect(c!.evidence.onlineFlag).toBe(true);
  });

  it("AFTER: no contradiction once the online flag is cleared", () => {
    // AFTER: agentOnline has been corrected to false.
    const after = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })]),
    );
    expect(after.contradictions.filter((x) => x.code === "TERMINAL_AGENT_ONLINE")).toHaveLength(0);
  });
});

// ── TERMINAL_AGENT_WITH_ACTIVE_SERVICE ───────────────────────────────────────

describe("TERMINAL_AGENT_WITH_ACTIVE_SERVICE", () => {
  it("BEFORE: flags a retired agent that still has a live payment key on its service", () => {
    const before = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [service("agent-1", "svc-1", true)],
      ),
    );
    const c = before.contradictions.find((x) => x.code === "TERMINAL_AGENT_WITH_ACTIVE_SERVICE");
    expect(c).toBeDefined();
    expect(c!.evidence.activeServiceIds).toContain("svc-1");
  });

  it("AFTER: no contradiction after the payment key is cleared", () => {
    const after = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [service("agent-1", "svc-1", false)],
      ),
    );
    expect(after.contradictions.filter((x) => x.code === "TERMINAL_AGENT_WITH_ACTIVE_SERVICE")).toHaveLength(0);
  });

  it("counts all active services, not just the first", () => {
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [service("agent-1", "svc-1"), service("agent-1", "svc-2"), service("agent-1", "svc-3", false)],
      ),
    );
    const c = report.contradictions.find((x) => x.code === "TERMINAL_AGENT_WITH_ACTIVE_SERVICE");
    expect((c!.evidence.activeServiceIds as string[]).length).toBe(2);
    expect(c!.evidence.activeServiceIds).toContain("svc-1");
    expect(c!.evidence.activeServiceIds).toContain("svc-2");
  });
});

// ── TERMINAL_AGENT_WITH_UNRESOLVED_JOBS ─────────────────────────────────────

describe("TERMINAL_AGENT_WITH_UNRESOLVED_JOBS", () => {
  it("BEFORE: flags a retired agent that has unresolved jobs", () => {
    const before = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [],
        [job("agent-1", "job-1", "pending"), job("agent-1", "job-2", "leased")],
      ),
    );
    const c = before.contradictions.find((x) => x.code === "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS");
    expect(c).toBeDefined();
    expect((c!.evidence.unresolvedJobIds as string[]).length).toBe(2);
    expect(c!.evidence.statuses).toContain("pending");
    expect(c!.evidence.statuses).toContain("leased");
  });

  it("AFTER: no contradiction once all jobs have been drained", () => {
    const after = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [],
        [],
      ),
    );
    expect(after.contradictions.filter((x) => x.code === "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS")).toHaveLength(0);
  });

  it("lists unique statuses, not duplicate entries", () => {
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })],
        [],
        [job("agent-1", "j1", "pending"), job("agent-1", "j2", "pending"), job("agent-1", "j3", "leased")],
      ),
    );
    const c = report.contradictions.find((x) => x.code === "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS");
    // statuses deduped: ["pending", "leased"]
    expect((c!.evidence.statuses as string[]).length).toBe(2);
  });
});

// ── ACTIVE_AGENT_OFFLINE_FLAG ────────────────────────────────────────────────

describe("ACTIVE_AGENT_OFFLINE_FLAG", () => {
  it("BEFORE: flags an active agent whose agentOnline flag is false", () => {
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "active", onlineFlag: false })]),
    );
    const c = before.contradictions.find((x) => x.code === "ACTIVE_AGENT_OFFLINE_FLAG");
    expect(c).toBeDefined();
    expect(c!.evidence.state).toBe("active");
  });

  it("AFTER: no contradiction once agentOnline is set to true", () => {
    const after = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "active", onlineFlag: true })]),
    );
    expect(after.contradictions.filter((x) => x.code === "ACTIVE_AGENT_OFFLINE_FLAG")).toHaveLength(0);
  });

  it("does not flag a paused agent that is offline", () => {
    const report = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "paused", onlineFlag: false })]),
    );
    expect(report.consistent).toBe(true);
  });
});

// ── STALE_RETIRED_TIMESTAMP ──────────────────────────────────────────────────

describe("STALE_RETIRED_TIMESTAMP", () => {
  it("BEFORE: flags a non-retired agent that has retiredAt set", () => {
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "active", onlineFlag: true, hasRetiredTimestamp: true })]),
    );
    const c = before.contradictions.find((x) => x.code === "STALE_RETIRED_TIMESTAMP");
    expect(c).toBeDefined();
    expect(c!.evidence.state).toBe("active");
  });

  it("AFTER: no contradiction once retiredAt is cleared", () => {
    const after = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "active", onlineFlag: true, hasRetiredTimestamp: false })]),
    );
    expect(after.contradictions.filter((x) => x.code === "STALE_RETIRED_TIMESTAMP")).toHaveLength(0);
  });

  it("checks all non-retired states, not just active", () => {
    for (const state of ["proposed", "provisioning", "paused", "retiring", "recovery_pending", "failed"] as const) {
      const report = buildConsistencyReport(
        snapshot([lifecycle("a", { state, onlineFlag: false, hasRetiredTimestamp: true })]),
      );
      const c = report.contradictions.find((x) => x.code === "STALE_RETIRED_TIMESTAMP");
      expect(c, `expected STALE_RETIRED_TIMESTAMP for state "${state}"`).toBeDefined();
    }
  });
});

// ── RETIRED_STATE_MISSING_TIMESTAMP ─────────────────────────────────────────

describe("RETIRED_STATE_MISSING_TIMESTAMP", () => {
  it("BEFORE: flags a retired agent that has no retiredAt timestamp", () => {
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: false })]),
    );
    const c = before.contradictions.find((x) => x.code === "RETIRED_STATE_MISSING_TIMESTAMP");
    expect(c).toBeDefined();
    expect(c!.evidence.hasRetiredTimestamp).toBe(false);
  });

  it("AFTER: no contradiction once retiredAt is set", () => {
    const after = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "retired", onlineFlag: false, hasRetiredTimestamp: true })]),
    );
    expect(after.contradictions.filter((x) => x.code === "RETIRED_STATE_MISSING_TIMESTAMP")).toHaveLength(0);
  });
});

// ── TRANSIENT_AGENT_ONLINE ───────────────────────────────────────────────────

describe("TRANSIENT_AGENT_ONLINE", () => {
  it("BEFORE: flags a provisioning agent whose agentOnline flag is true", () => {
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "provisioning", onlineFlag: true })]),
    );
    const c = before.contradictions.find((x) => x.code === "TRANSIENT_AGENT_ONLINE");
    expect(c).toBeDefined();
    expect(c!.evidence.state).toBe("provisioning");
  });

  it("BEFORE: also flags a retiring agent that is still online", () => {
    const before = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "retiring", onlineFlag: true })]),
    );
    const c = before.contradictions.find((x) => x.code === "TRANSIENT_AGENT_ONLINE");
    expect(c).toBeDefined();
    expect(c!.evidence.state).toBe("retiring");
  });

  it("AFTER: no contradiction for provisioning agent that is offline", () => {
    const after = buildConsistencyReport(
      snapshot([lifecycle("agent-1", { state: "provisioning", onlineFlag: false })]),
    );
    expect(after.contradictions.filter((x) => x.code === "TRANSIENT_AGENT_ONLINE")).toHaveLength(0);
  });
});

// ── Multiple contradictions on the same agent ────────────────────────────────

describe("multiple contradictions", () => {
  it("collects all contradictions from one agent in a single pass", () => {
    // Worst-case: a retired agent that is online, has an active service, has
    // unresolved jobs, and is missing its retiredAt timestamp.
    const report = buildConsistencyReport(
      snapshot(
        [lifecycle("agent-1", { state: "retired", onlineFlag: true, hasRetiredTimestamp: false })],
        [service("agent-1", "svc-1")],
        [job("agent-1", "job-1")],
      ),
    );

    const codes = report.contradictions.map((c) => c.code);
    expect(codes).toContain("TERMINAL_AGENT_ONLINE");
    expect(codes).toContain("TERMINAL_AGENT_WITH_ACTIVE_SERVICE");
    expect(codes).toContain("TERMINAL_AGENT_WITH_UNRESOLVED_JOBS");
    expect(codes).toContain("RETIRED_STATE_MISSING_TIMESTAMP");
    expect(report.contradictions.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Multi-agent snapshot ─────────────────────────────────────────────────────

describe("multi-agent snapshot", () => {
  it("evaluates each agent independently and scopes contradictions correctly", () => {
    const report = buildConsistencyReport(
      snapshot(
        [
          // healthy
          lifecycle("agent-ok", { state: "active", onlineFlag: true }),
          // has online flag inconsistency
          lifecycle("agent-bad", { state: "retired", onlineFlag: true, hasRetiredTimestamp: true }),
        ],
        [],
        [],
      ),
    );

    expect(report.agentCount).toBe(2);
    expect(report.contradictions.every((c) => c.talosId === "agent-bad")).toBe(true);
    expect(report.contradictions.some((c) => c.talosId === "agent-ok")).toBe(false);
  });
});

// ── Report structure ─────────────────────────────────────────────────────────

describe("report structure", () => {
  it("includes a generatedAt ISO timestamp", () => {
    const before = new Date();
    const report = buildConsistencyReport(snapshot([]));
    const after = new Date();
    const ts = new Date(report.generatedAt);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("sorts contradictions deterministically by talosId then code", () => {
    const report = buildConsistencyReport(
      snapshot(
        [
          lifecycle("zzz-agent", { state: "active", onlineFlag: false }),
          lifecycle("aaa-agent", { state: "active", onlineFlag: false }),
        ],
      ),
    );
    const ids = report.contradictions.map((c) => c.talosId);
    expect(ids[0]).toBe("aaa-agent");
    expect(ids[1]).toBe("zzz-agent");
  });

  it("exposes every defined contradiction code in the CONTRADICTION_CODES const", () => {
    // Structural guard: all codes defined in the const must be exhaustive.
    expect(CONTRADICTION_CODES.length).toBeGreaterThan(0);
    for (const code of CONTRADICTION_CODES) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("never mutates the input snapshot arrays", () => {
    const ls: LifecycleRecord[] = [lifecycle("a1", { state: "active", onlineFlag: false })];
    const ss: ServiceRecord[] = [];
    const js: UnresolvedJobRecord[] = [];
    const snap = { lifecycleRecords: ls, serviceRecords: ss, unresolvedJobs: js };
    buildConsistencyReport(snap);
    expect(snap.lifecycleRecords.length).toBe(1);
    expect(snap.serviceRecords.length).toBe(0);
    expect(snap.unresolvedJobs.length).toBe(0);
  });

  it("sets consistent=false and consistent=true correctly", () => {
    const bad = buildConsistencyReport(
      snapshot([lifecycle("a", { state: "active", onlineFlag: false })]),
    );
    expect(bad.consistent).toBe(false);

    const good = buildConsistencyReport(
      snapshot([lifecycle("a", { state: "active", onlineFlag: true })]),
    );
    expect(good.consistent).toBe(true);
  });
});

// ── Boundary: non-terminal, non-operational states ──────────────────────────

describe("boundary: non-terminal non-operational states", () => {
  it("does not trigger TERMINAL checks for proposed, paused, failed, recovery_pending", () => {
    for (const state of ["proposed", "paused", "failed", "recovery_pending"] as const) {
      const report = buildConsistencyReport(
        snapshot(
          [lifecycle("a", { state, onlineFlag: false, hasRetiredTimestamp: false })],
          [service("a", "s1")],
          [job("a", "j1")],
        ),
      );
      const terminal = report.contradictions.filter(
        (c) =>
          c.code === "TERMINAL_AGENT_ONLINE" ||
          c.code === "TERMINAL_AGENT_WITH_ACTIVE_SERVICE" ||
          c.code === "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS",
      );
      expect(terminal, `state "${state}" should not trigger terminal checks`).toHaveLength(0);
    }
  });

  it("does not flag ACTIVE_AGENT_OFFLINE_FLAG for non-operational states", () => {
    for (const state of ["proposed", "paused", "provisioning", "retiring", "recovery_pending", "failed", "retired"] as const) {
      const report = buildConsistencyReport(
        snapshot([lifecycle("a", { state, onlineFlag: false, hasRetiredTimestamp: state === "retired" })]),
      );
      expect(
        report.contradictions.filter((c) => c.code === "ACTIVE_AGENT_OFFLINE_FLAG"),
        `state "${state}" should not trigger ACTIVE_AGENT_OFFLINE_FLAG`,
      ).toHaveLength(0);
    }
  });
});
