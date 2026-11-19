// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { JobsClient, type JobRecordView } from "../src/app/admin/jobs/jobs-client";

const mockPendingJob: JobRecordView = {
  id: "job_pending_1",
  queue: "audit_log_write",
  payload: {
    talosId: "agent_abc",
    action: "wallet_read",
    apiKey: "sk-secret-12345",
    nested: { token: "tok_secret_999" },
  },
  status: "pending",
  priority: 10,
  runAt: "2026-10-20T08:00:00.000Z",
  leaseId: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attempts: 0,
  maxAttempts: 8,
  retryClass: "transient",
  cancelRequested: false,
  idempotencyKey: "idem_1",
  lastError: null,
  result: null,
  createdAt: "2026-10-20T07:55:00.000Z",
  updatedAt: "2026-10-20T07:55:00.000Z",
  completedAt: null,
};

const mockDeadLetterJob: JobRecordView = {
  id: "job_dead_letter_2",
  queue: "settlement_payout",
  payload: {
    amount: "1000",
    destination: "GABC123",
    secret: "SSECRET_KEY",
  },
  status: "dead_letter",
  priority: 5,
  runAt: "2026-10-20T08:10:00.000Z",
  leaseId: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attempts: 8,
  maxAttempts: 8,
  retryClass: "transient",
  cancelRequested: false,
  idempotencyKey: null,
  lastError: "Horizon network timeout after 30s",
  result: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:15:00.000Z",
  completedAt: null,
};

const mockCompletedJob: JobRecordView = {
  id: "job_completed_3",
  queue: "metrics_roll_up",
  payload: { date: "2026-10-19" },
  status: "completed",
  priority: 0,
  runAt: "2026-10-20T07:00:00.000Z",
  leaseId: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attempts: 1,
  maxAttempts: 8,
  retryClass: "transient",
  cancelRequested: false,
  idempotencyKey: null,
  lastError: null,
  result: { processed: 42 },
  createdAt: "2026-10-20T06:55:00.000Z",
  updatedAt: "2026-10-20T07:01:00.000Z",
  completedAt: "2026-10-20T07:01:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(...responses: Response[]) {
  const mock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => responses.shift() ?? new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("JobsClient Component Tests", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("Admin Authentication & Session Pattern", () => {
    it("loads stored admin API key from sessionStorage on mount", () => {
      sessionStorage.setItem("talos_admin_api_key", "stored-admin-secret");
      render(<JobsClient />);

      const keyInput = screen.getByTestId("jobs-admin-key") as HTMLInputElement;
      expect(keyInput.value).toBe("stored-admin-secret");
    });

    it("persists updated admin API key to sessionStorage and updates state", () => {
      render(<JobsClient />);
      const keyInput = screen.getByTestId("jobs-admin-key") as HTMLInputElement;

      fireEvent.change(keyInput, { target: { value: "new-session-key" } });
      expect(keyInput.value).toBe("new-session-key");
      expect(sessionStorage.getItem("talos_admin_api_key")).toBe("new-session-key");

      fireEvent.change(keyInput, { target: { value: "" } });
      expect(sessionStorage.getItem("talos_admin_api_key")).toBeNull();
    });

    it("shows a descriptive error when trying to fetch without an admin API key", () => {
      render(<JobsClient />);
      const submitBtn = screen.getByTestId("jobs-load");

      fireEvent.click(submitBtn);

      const errorAlert = screen.getByTestId("jobs-error");
      expect(errorAlert.textContent).toContain("Enter the ADMIN_API_KEY to load background jobs.");
    });
  });

  describe("Listing and Filtering Jobs", () => {
    it("fetches and lists jobs with the Authorization Bearer header", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const fetchMock = stubFetch(
        jsonResponse({
          jobs: [mockPendingJob, mockDeadLetterJob, mockCompletedJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getAllByTestId("jobs-row")).toHaveLength(3);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/jobs?limit=25"),
        expect.objectContaining({
          headers: { authorization: "Bearer valid-admin-key" },
        }),
      );

      // Verify column content is rendered properly
      expect(screen.getByText("audit_log_write")).toBeTruthy();
      expect(screen.getByText("settlement_payout")).toBeTruthy();
      expect(screen.getByText("metrics_roll_up")).toBeTruthy();
      expect(screen.getByTestId("jobs-status-job_pending_1").textContent).toBe("pending");
      expect(screen.getByTestId("jobs-status-job_dead_letter_2").textContent).toBe("dead_letter");
      expect(screen.getByTestId("jobs-status-job_completed_3").textContent).toBe("completed");
    });

    it("applies status and queue filters in API query", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const fetchMock = stubFetch(
        jsonResponse({
          jobs: [mockDeadLetterJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);

      // Set status filter to dead_letter
      const statusSelect = screen.getByTestId("jobs-filter-status");
      fireEvent.change(statusSelect, { target: { value: "dead_letter" } });

      // Set queue filter
      const queueInput = screen.getByTestId("jobs-filter-queue");
      fireEvent.change(queueInput, { target: { value: "settlement_payout" } });

      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/admin/jobs?limit=25&status=dead_letter&queue=settlement_payout"),
          expect.anything(),
        );
      });

      // Clear filters button should be visible and working
      const clearBtn = screen.getByTestId("jobs-clear-filter");
      expect(clearBtn).toBeTruthy();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          jobs: [mockPendingJob, mockDeadLetterJob, mockCompletedJob],
          nextCursor: null,
        }),
      );

      fireEvent.click(clearBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenLastCalledWith(
          "/api/admin/jobs?limit=25",
          expect.anything(),
        );
      });
    });

    it("displays an empty state message when no jobs match filters", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      stubFetch(jsonResponse({ jobs: [], nextCursor: null }));

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-empty")).toBeTruthy();
        expect(screen.getByTestId("jobs-empty").textContent).toContain("No background jobs match the current filters.");
      });
    });
  });

  describe("Cursor Pagination", () => {
    it("renders 'Load more' button when nextCursor is returned and appends subsequent page", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const cursorValue = "2026-10-20T08:00:00.000Z";

      const fetchMock = stubFetch(
        // First page
        jsonResponse({
          jobs: [mockPendingJob],
          nextCursor: cursorValue,
        }),
        // Second page
        jsonResponse({
          jobs: [mockDeadLetterJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getAllByTestId("jobs-row")).toHaveLength(1);
      });

      const loadMoreBtn = screen.getByTestId("jobs-load-more");
      expect(loadMoreBtn).toBeTruthy();

      fireEvent.click(loadMoreBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId("jobs-row")).toHaveLength(2);
      });

      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining(`/api/admin/jobs?limit=25&cursor=${encodeURIComponent(cursorValue)}`),
        expect.anything(),
      );

      // Once nextCursor is null, load more button disappears
      expect(screen.queryByTestId("jobs-load-more")).toBeNull();
    });
  });

  describe("Detail Drawer & Payload Redaction", () => {
    it("opens drawer on Inspect click, displays job metadata, and redacts sensitive payload fields", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      stubFetch(
        jsonResponse({
          jobs: [mockPendingJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-inspect-job_pending_1")).toBeTruthy();
      });

      // Click Inspect
      fireEvent.click(screen.getByTestId("jobs-inspect-job_pending_1"));

      const drawer = screen.getByTestId("jobs-drawer");
      expect(drawer).toBeTruthy();
      expect(screen.getByTestId("jobs-drawer-id").textContent).toBe(mockPendingJob.id);

      // Payload must be redacted
      const payloadEl = screen.getByTestId("jobs-drawer-payload");
      expect(payloadEl.textContent).toContain("[REDACTED]");
      expect(payloadEl.textContent).toContain("agent_abc");
      expect(payloadEl.textContent).toContain("wallet_read");
      // Secrets must NOT be present in plaintext
      expect(payloadEl.textContent).not.toContain("sk-secret-12345");
      expect(payloadEl.textContent).not.toContain("tok_secret_999");

      // Closes on close button click
      const closeBtn = screen.getByTestId("jobs-drawer-close");
      fireEvent.click(closeBtn);
      expect(screen.queryByTestId("jobs-drawer")).toBeNull();
    });

    it("displays last error prominently in the detail drawer when present", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      stubFetch(
        jsonResponse({
          jobs: [mockDeadLetterJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-inspect-job_dead_letter_2")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-inspect-job_dead_letter_2"));

      const lastErrorEl = screen.getByTestId("jobs-drawer-last-error");
      expect(lastErrorEl.textContent).toBe("Horizon network timeout after 30s");

      // Also checks secret redaction on dead letter job payload
      const payloadEl = screen.getByTestId("jobs-drawer-payload");
      expect(payloadEl.textContent).toContain("[REDACTED]");
      expect(payloadEl.textContent).not.toContain("SSECRET_KEY");
    });

    it("closes drawer on Escape key press", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      stubFetch(
        jsonResponse({
          jobs: [mockPendingJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-inspect-job_pending_1")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-inspect-job_pending_1"));
      expect(screen.getByTestId("jobs-drawer")).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByTestId("jobs-drawer")).toBeNull();
    });
  });

  describe("Cancel Action with Confirmation", () => {
    it("opens confirmation dialog on cancel click, and does not cancel if dismissed", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const fetchMock = stubFetch(
        jsonResponse({
          jobs: [mockPendingJob],
          nextCursor: null,
        }),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-cancel-job_pending_1")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-cancel-job_pending_1"));

      const confirmDialog = screen.getByTestId("jobs-confirm-dialog");
      expect(confirmDialog).toBeTruthy();
      expect(confirmDialog.textContent).toContain("Confirm Job Cancellation");
      expect(confirmDialog.textContent).toContain("job_pending_1");

      // Dismiss dialog
      fireEvent.click(screen.getByTestId("jobs-confirm-dismiss"));
      expect(screen.queryByTestId("jobs-confirm-dialog")).toBeNull();

      // No cancel API call should have been made
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("executes cancel request on confirmation and updates job status to cancelled", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const cancelledJob = { ...mockPendingJob, status: "cancelled", cancelRequested: true };

      const fetchMock = stubFetch(
        jsonResponse({
          jobs: [mockPendingJob],
          nextCursor: null,
        }),
        jsonResponse(cancelledJob),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-cancel-job_pending_1")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-cancel-job_pending_1"));
      fireEvent.click(screen.getByTestId("jobs-confirm-proceed"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-status-job_pending_1").textContent).toBe("cancelled");
      });

      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/admin/jobs/job_pending_1/cancel",
        expect.objectContaining({
          method: "POST",
          headers: { authorization: "Bearer valid-admin-key" },
        }),
      );
    });
  });

  describe("Retry Action with Confirmation", () => {
    it("opens confirmation dialog on retry click and executes requeue on confirmation", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");
      const retriedJob = {
        ...mockDeadLetterJob,
        status: "pending",
        attempts: 0,
        lastError: null,
      };

      const fetchMock = stubFetch(
        jsonResponse({
          jobs: [mockDeadLetterJob],
          nextCursor: null,
        }),
        jsonResponse(retriedJob),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-retry-job_dead_letter_2")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-retry-job_dead_letter_2"));

      const confirmDialog = screen.getByTestId("jobs-confirm-dialog");
      expect(confirmDialog).toBeTruthy();
      expect(confirmDialog.textContent).toContain("Confirm Job Retry");
      expect(confirmDialog.textContent).toContain("job_dead_letter_2");

      fireEvent.click(screen.getByTestId("jobs-confirm-proceed"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-status-job_dead_letter_2").textContent).toBe("pending");
        expect(screen.getByText("Requeued")).toBeTruthy();
      });

      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/admin/jobs/job_dead_letter_2/retry",
        expect.objectContaining({
          method: "POST",
          headers: { authorization: "Bearer valid-admin-key" },
        }),
      );
    });

    it("displays error when retry returns a 409 conflict", async () => {
      sessionStorage.setItem("talos_admin_api_key", "valid-admin-key");

      stubFetch(
        jsonResponse({
          jobs: [mockDeadLetterJob],
          nextCursor: null,
        }),
        jsonResponse({ error: "Job is not in a retryable state (status=completed)" }, 409),
      );

      render(<JobsClient />);
      fireEvent.click(screen.getByTestId("jobs-load"));

      await waitFor(() => {
        expect(screen.getByTestId("jobs-retry-job_dead_letter_2")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("jobs-retry-job_dead_letter_2"));
      fireEvent.click(screen.getByTestId("jobs-confirm-proceed"));

      await waitFor(() => {
        expect(screen.getByText("Job is not in a retryable state (status=completed)")).toBeTruthy();
      });
    });
  });
});
