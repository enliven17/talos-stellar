import { describe, expect, it } from "vitest";
import {
  buildLifecycleConsistencyReport,
  type LifecycleJob,
  type LifecycleService,
} from "./lifecycle";
import type { AgentLifecycleRecord } from "./types";

function record(
  agentId: string,
  state: AgentLifecycleRecord["state"],
): AgentLifecycleRecord {
  return { agentId, state } as AgentLifecycleRecord;
}

function service(
  id: string,
  agentId: string,
  active: boolean,
): LifecycleService {
  return { id, agentId, active };
}

function job(id: string, agentId: string, resolved: boolean): LifecycleJob {
  return { id, agentId, resolved };
}

describe("buildLifecycleConsistencyReport", () => {
  it("reports a consistent set when records, services and jobs agree", () => {
    const report = buildLifecycleConsistencyReport({
      records: [record("agent-1", "active")],
      services: [service("svc-1", "agent-1", true)],
      jobs: [job("job-1", "agent-1", true)],
    });

    expect(report.consistent).toBe(true);
    expect(report.contradictions).toEqual([]);
  });

  it("flags retired agents with active services and unresolved jobs", () => {
    const report = buildLifecycleConsistencyReport({
      records: [record("agent-1", "retired")],
      services: [service("svc-1", "agent-1", true)],
      jobs: [job("job-1", "agent-1", false)],
    });

    expect(report.consistent).toBe(false);
    expect(report.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "retired_agent_with_active_service",
          agentId: "agent-1",
          serviceId: "svc-1",
        }),
        expect.objectContaining({
          kind: "unresolved_jobs_on_retired_agent",
          agentId: "agent-1",
          jobIds: ["job-1"],
        }),
      ]),
    );
  });

  it("flags active services without a lifecycle record", () => {
    const report = buildLifecycleConsistencyReport({
      records: [],
      services: [service("svc-1", "agent-1", true)],
      jobs: [],
    });

    expect(report.consistent).toBe(false);
    expect(report.contradictions).toEqual([
      expect.objectContaining({
        kind: "active_service_without_lifecycle_record",
        agentId: "agent-1",
        serviceId: "svc-1",
      }),
    ]);
  });

  it("ignores inactive services and resolved jobs", () => {
    const report = buildLifecycleConsistencyReport({
      records: [record("agent-1", "retired")],
      services: [service("svc-1", "agent-1", false)],
      jobs: [job("job-1", "agent-1", true)],
    });

    expect(report.consistent).toBe(true);
    expect(report.contradictions).toEqual([]);
  });
});
