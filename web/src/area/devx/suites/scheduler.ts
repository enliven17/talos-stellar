import { BenchmarkOptions } from "../runner";
import { loadConfig } from "../config";
import { generateTalosIds } from "../datasets";

const config = loadConfig({ runs: 50, warmupRuns: 5 });

interface SchedulerState {
  cycleCount: number;
  lastCycleAt: number;
  pendingJobs: number;
  activeApprovals: number;
  dividendDue: boolean;
  loanDue: boolean;
  agentOnline: boolean;
}

function createSchedulerState(): SchedulerState {
  return {
    cycleCount: 0,
    lastCycleAt: Date.now() - 60000,
    pendingJobs: Math.floor(Math.random() * 20),
    activeApprovals: Math.floor(Math.random() * 5),
    dividendDue: Math.random() > 0.7,
    loanDue: Math.random() > 0.8,
    agentOnline: true,
  };
}

function simulateCycle(state: SchedulerState): SchedulerState {
  const next = { ...state, cycleCount: state.cycleCount + 1, lastCycleAt: Date.now() };

  if (state.pendingJobs > 0) {
    const claimable = Math.min(state.pendingJobs, 3);
    next.pendingJobs -= claimable;
  }

  if (state.activeApprovals > 0) {
    next.activeApprovals -= 1;
  }

  if (state.dividendDue && state.agentOnline) {
    next.dividendDue = false;
  }

  if (state.loanDue && state.agentOnline) {
    next.loanDue = false;
  }

  return next;
}

function simulatePendingJobsCheck(count: number): { id: string; status: string; amount: string }[] {
  const jobs: { id: string; status: string; amount: string }[] = [];
  for (let i = 0; i < count; i++) {
    jobs.push({
      id: `job-${i}`,
      status: "pending",
      amount: `${(Math.random() * 100).toFixed(2)}`,
    });
  }
  return jobs;
}

function simulateAgentDecision(state: SchedulerState): string[] {
  const actions: string[] = [];

  if (state.pendingJobs > 0 && state.agentOnline) {
    actions.push("claim_job");
  }

  if (state.activeApprovals > 0 && state.agentOnline) {
    actions.push("check_approvals");
  }

  if (state.dividendDue && state.agentOnline) {
    actions.push("distribute_dividends");
  }

  if (state.loanDue && state.agentOnline) {
    actions.push("repay_loans");
  }

  if (actions.length === 0 && state.agentOnline) {
    actions.push("idle_sleep");
  }

  return actions;
}

export function schedulerLoopSuite(): BenchmarkOptions[] {
  return [
    {
      label: "scheduler-simulate-cycles",
      fn: () => {
        let state = createSchedulerState();
        for (let i = 0; i < 100; i++) {
          state = simulateCycle(state);
        }
      },
      config,
    },
    {
      label: "scheduler-pending-jobs-check",
      fn: () => {
        const jobs = simulatePendingJobsCheck(100);
        const pending = jobs.filter((j) => j.status === "pending");
        pending.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));
      },
      config,
    },
    {
      label: "scheduler-agent-decision",
      fn: () => {
        const state = createSchedulerState();
        for (let i = 0; i < 50; i++) {
          const actions = simulateAgentDecision(state);
          state.cycleCount++;
          state.pendingJobs = Math.max(0, state.pendingJobs - actions.length);
        }
      },
      config,
    },
    {
      label: "scheduler-state-transitions",
      fn: () => {
        const states: SchedulerState[] = [];
        let state = createSchedulerState();
        for (let i = 0; i < 200; i++) {
          state = simulateCycle(state);
          if (i % 10 === 0) states.push({ ...state });
        }
        JSON.stringify(states);
      },
      config,
    },
    {
      label: "scheduler-dividend-preview",
      fn: () => {
        const patrons = Array.from({ length: 50 }, (_, i) => ({
          id: `patron-${i}`,
          stellarPublicKey: `G${"A".repeat(55)}`,
          pulseAmount: Math.floor(Math.random() * 10000),
          share: ((Math.random() * 100) / 100).toFixed(4),
        }));
        const totalPulse = patrons.reduce((s, p) => s + p.pulseAmount, 0);
        const poolAmount = 1000;
        const breakdown = patrons.map((p) => ({
          stellarPublicKey: p.stellarPublicKey,
          pulseAmount: p.pulseAmount,
          amount: ((poolAmount * (p.pulseAmount / totalPulse))).toFixed(2),
        }));
        JSON.stringify({ poolAmount, breakdown });
      },
      config,
    },
  ];
}

export function schedulerSuites(): BenchmarkOptions[] {
  return schedulerLoopSuite();
}