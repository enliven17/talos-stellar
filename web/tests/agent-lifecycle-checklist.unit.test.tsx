// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentLifecycleChecklist } from "../src/components/agent-lifecycle-checklist";
import type { LifecycleChecklist } from "../src/lib/governance/lifecycle";

const OWNER_KEY = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IF2WSMV7CU5";
const NON_OWNER_KEY = "GBTYAFGQ3F5DY6CW7AH5GULB4V2I6NWAKPO6Z6YZZ7M7YFXN2B6Q2JEU";

let mockAddress: string | null = OWNER_KEY;

vi.mock("@/components/wallet-gate", () => ({
  useWallet: () => ({
    isConnected: Boolean(mockAddress),
    address: mockAddress,
    connect: vi.fn(),
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const mockChecklistPending: LifecycleChecklist = {
  talosId: "agent-123",
  state: "paused",
  isOwner: true,
  canRetire: false,
  obligations: [
    {
      id: "owner_authorization",
      title: "Owner Signature Proof",
      description: "Must be signed by creator or wallet owner.",
      satisfied: true,
      blocking: true,
    },
    {
      id: "in_flight_jobs",
      title: "Drain Active Jobs",
      description: "2 active jobs are currently running.",
      satisfied: false,
      blocking: true,
      count: 2,
    },
    {
      id: "service_availability",
      title: "Service Intake Paused",
      description: "Agent service is offline and intake is halted.",
      satisfied: true,
      blocking: true,
    },
  ],
  allowedNextActions: [
    {
      action: "resume",
      label: "Resume Agent",
      targetState: "active",
      enabled: true,
      description: "Re-enable agent operations and service intake.",
      blockingObligationIds: [],
    },
    {
      action: "retire",
      label: "Retire Agent",
      targetState: "retired",
      enabled: false,
      description: "Permanently retire this agent. Requires in-flight jobs drained.",
      blockingObligationIds: ["in_flight_jobs"],
    },
  ],
};

const mockChecklistReady: LifecycleChecklist = {
  talosId: "agent-123",
  state: "paused",
  isOwner: true,
  canRetire: true,
  obligations: [
    {
      id: "owner_authorization",
      title: "Owner Signature Proof",
      description: "Must be signed by creator or wallet owner.",
      satisfied: true,
      blocking: true,
    },
    {
      id: "in_flight_jobs",
      title: "Drain Active Jobs",
      description: "No jobs in-flight.",
      satisfied: true,
      blocking: true,
      count: 0,
    },
    {
      id: "service_availability",
      title: "Service Intake Paused",
      description: "Agent service is offline and intake is halted.",
      satisfied: true,
      blocking: true,
    },
  ],
  allowedNextActions: [
    {
      action: "resume",
      label: "Resume Agent",
      targetState: "active",
      enabled: true,
      description: "Re-enable agent operations and service intake.",
      blockingObligationIds: [],
    },
    {
      action: "retire",
      label: "Retire Agent",
      targetState: "retired",
      enabled: true,
      description: "Permanently retire this agent.",
      blockingObligationIds: [],
    },
  ],
};

const mockChecklistRetired: LifecycleChecklist = {
  talosId: "agent-123",
  state: "retired",
  isOwner: true,
  canRetire: false,
  obligations: [
    {
      id: "owner_authorization",
      title: "Owner Signature Proof",
      description: "Historical retirement proof verified.",
      satisfied: true,
      blocking: false,
    },
  ],
  allowedNextActions: [],
};

describe("AgentLifecycleChecklist", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAddress = OWNER_KEY;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders checklist with pending blocking obligations and disabled retire action", () => {
    render(
      <AgentLifecycleChecklist
        talosId="agent-123"
        checklist={mockChecklistPending}
      />
    );

    expect(screen.getByTestId("lifecycle-checklist")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-readiness-badge")).toHaveTextContent("Obligations Pending");
    
    const inFlightObligation = screen.getByTestId("obligation-in_flight_jobs");
    expect(inFlightObligation).toHaveTextContent("Drain Active Jobs");
    expect(inFlightObligation).toHaveTextContent("2");
    expect(inFlightObligation).toHaveTextContent("Blocking");
    expect(inFlightObligation).toHaveTextContent("[!]");

    const retireAction = screen.getByTestId("action-retire");
    expect(retireAction).toHaveTextContent("Blocked");
    expect(retireAction).toHaveTextContent("Blocked by: Drain Active Jobs");
  });

  it("renders ready state when all obligations are cleared and enables retirement action", () => {
    const onActionClick = vi.fn();
    render(
      <AgentLifecycleChecklist
        talosId="agent-123"
        checklist={mockChecklistReady}
        onActionClick={onActionClick}
      />
    );

    expect(screen.getByTestId("checklist-readiness-badge")).toHaveTextContent("Ready for Retirement");
    const retireAction = screen.getByTestId("action-retire");
    expect(retireAction).toHaveTextContent("Available");

    const retireButton = screen.getByRole("button", { name: "Retire Agent" });
    fireEvent.click(retireButton);
    expect(onActionClick).toHaveBeenCalledWith("retire");
  });

  it("renders terminal retired state with no further actions permitted", () => {
    render(
      <AgentLifecycleChecklist
        talosId="agent-123"
        checklist={mockChecklistRetired}
      />
    );

    expect(screen.getByTestId("checklist-readiness-badge")).toHaveTextContent("Retired");
    expect(screen.getByTestId("checklist-no-actions")).toHaveTextContent(
      "No further actions permitted (terminal state)."
    );
  });

  it("fetches checklist from /api/talos/:id/retire when checklist prop is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(mockChecklistReady));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentLifecycleChecklist talosId="agent-123" />);

    expect(screen.getByTestId("lifecycle-checklist-loading")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-checklist")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/talos/agent-123/retire?viewer=${encodeURIComponent(OWNER_KEY)}`,
      { cache: "no-store" }
    );
    expect(screen.getByTestId("checklist-readiness-badge")).toHaveTextContent("Ready for Retirement");
  });

  it("handles fetch failure gracefully and displays an error notice", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: "Agent not found" }, 404)
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentLifecycleChecklist talosId="agent-404" />);

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-checklist-error")).toBeInTheDocument();
    });

    expect(screen.getByTestId("lifecycle-checklist-error")).toHaveTextContent("Agent not found");
  });

  it("indicates restricted view when user is not owner", () => {
    mockAddress = NON_OWNER_KEY;
    const nonOwnerChecklist: LifecycleChecklist = {
      ...mockChecklistPending,
      isOwner: false,
      obligations: [
        {
          id: "owner_authorization",
          title: "Owner Authorization Required",
          description: "Only creator or designated wallet can transition agent lifecycle.",
          satisfied: false,
          blocking: true,
        },
      ],
      allowedNextActions: [],
    };

    render(
      <AgentLifecycleChecklist
        talosId="agent-123"
        checklist={nonOwnerChecklist}
        isOwner={false}
      />
    );

    expect(screen.getByTestId("lifecycle-non-owner-notice")).toBeInTheDocument();
    expect(screen.getByText(/You are viewing in read-only mode/i)).toBeInTheDocument();
  });
});
