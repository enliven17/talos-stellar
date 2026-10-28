import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosConflictError,
  TalosAPIError,
  type ClaimedJob,
  type HeartbeatResponse,
  type ReleaseJobResponse,
  type JobProgressResponse,
  type CommerceJob,
} from "../src/index.js";

describe("TalosClient - Job lease methods", () => {
  const client = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "test-key" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("claimJob", () => {
    it("sends POST to /api/jobs/:id/claim with optional ttlSeconds", async () => {
      const mockResponse: ClaimedJob = {
        id: "job-1",
        leasedBy: "talos-1",
        leasedAt: "2026-01-01T00:00:00.000Z",
        leaseExpiresAt: "2026-01-01T00:05:00.000Z",
        fencingToken: 1,
        status: "pending",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.claimJob("job-1", { ttlSeconds: 120 });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/jobs/job-1/claim",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ttlSeconds: 120 }),
        }),
      );
      expect(result).toEqual(mockResponse);
      expect(result.fencingToken).toBe(1);
    });

    it("sends empty body when params are omitted", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "job-1", fencingToken: 0, status: "pending" }),
      } as Response);

      await client.claimJob("job-1");

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.body).toBe(JSON.stringify({}));
    });

    it("maps 409 (already leased) to TalosConflictError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: "Job is already leased by another worker",
            detail: "The job has a valid, unexpired lease held by another agent",
          }),
      } as Response);

      await expect(client.claimJob("job-1")).rejects.toThrow(TalosConflictError);
      try {
        await client.claimJob("job-1");
      } catch (err) {
        expect(err).toBeInstanceOf(TalosConflictError);
        expect((err as TalosConflictError).code).toBe("conflict_error");
        expect((err as TalosConflictError).status).toBe(409);
      }
    });
  });

  describe("heartbeatJob", () => {
    it("sends POST to /api/jobs/:id/heartbeat with fencingToken", async () => {
      const mockResponse: HeartbeatResponse = {
        renewed: true,
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.heartbeatJob("job-1", { fencingToken: 5 });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/jobs/job-1/heartbeat",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ fencingToken: 5 }),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("maps 409 (fencing token mismatch) to TalosConflictError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: "Lease not held or fencing token mismatch",
            detail: "The job may have been taken over by another worker or the fencing token is stale",
          }),
      } as Response);

      await expect(
        client.heartbeatJob("job-1", { fencingToken: 99 }),
      ).rejects.toThrow(TalosConflictError);
      try {
        await client.heartbeatJob("job-1", { fencingToken: 99 });
      } catch (err) {
        expect(err).toBeInstanceOf(TalosConflictError);
        expect((err as TalosConflictError).code).toBe("conflict_error");
        expect((err as TalosConflictError).status).toBe(409);
      }
    });
  });

  describe("extendJobLease", () => {
    it("delegates to heartbeatJob with the correct path and body", async () => {
      const mockResponse: HeartbeatResponse = {
        renewed: true,
        leaseExpiresAt: "2026-01-01T00:15:00.000Z",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.extendJobLease("job-1", { fencingToken: 3 });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/jobs/job-1/heartbeat",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ fencingToken: 3 }),
        }),
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe("releaseJob", () => {
    it("sends POST to /api/jobs/:id/release with fencingToken", async () => {
      const mockResponse: ReleaseJobResponse = {
        released: true,
        jobId: "job-1",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.releaseJob("job-1", { fencingToken: 7 });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/jobs/job-1/release",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ fencingToken: 7 }),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("maps 409 to TalosConflictError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ error: "Lease not held or fencing token mismatch" }),
      } as Response);

      await expect(
        client.releaseJob("job-1", { fencingToken: 7 }),
      ).rejects.toThrow(TalosConflictError);
    });
  });

  describe("reportJobProgress", () => {
    it("sends POST to /api/jobs/:id/progress with percent/stage/message", async () => {
      const mockResponse: JobProgressResponse = {
        id: "job-1",
        status: "pending",
        progress: { percent: 50, stage: "processing" },
        fencingToken: 5,
        updatedAt: "2026-01-01T00:03:00.000Z",
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await client.reportJobProgress("job-1", {
        percent: 50,
        stage: "processing",
        message: "halfway done",
        fencingToken: 5,
      });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/jobs/job-1/progress",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            percent: 50,
            stage: "processing",
            message: "halfway done",
            fencingToken: 5,
          }),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("maps 409 (job completed) to TalosConflictError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ error: "Job already completed" }),
      } as Response);

      await expect(
        client.reportJobProgress("job-1", { percent: 100 }),
      ).rejects.toThrow(TalosConflictError);
    });
  });

  describe("Lease conflict distinguishability", () => {
    it("TalosConflictError is distinguishable from generic TalosAPIError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ error: "Job is already leased by another worker" }),
      } as Response);

      try {
        await client.claimJob("job-1");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TalosConflictError);
        expect(err).toBeInstanceOf(TalosAPIError);
        // instanceof TalosConflictError is true, instanceof TalosAPIError is true,
        // but the caller can distinguish by checking for TalosConflictError.
        expect((err as TalosConflictError).name).toBe("TalosConflictError");
        expect((err as TalosConflictError).code).toBe("conflict_error");
      }
    });
  });
});
