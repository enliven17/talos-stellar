import { describe, it, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities } from "@/db/schema";
import { eq } from "drizzle-orm";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

// Shared state across tests
let talosId: string;
let apiKey: string;
const creatorKeypair = Keypair.random();

describe("Retired Agent Preservation - Issue #315", () => {
  beforeAll(async () => {
    // Clean up any existing test data
    await db.delete(tlsActivities).where(eq(tlsActivities.talosId, "test-retire-id"));
    await db.delete(tlsPatrons).where(eq(tlsPatrons.talosId, "test-retire-id"));
    await db.delete(tlsTalos).where(eq(tlsTalos.id, "test-retire-id"));
  });

  describe("POST /api/talos/:id/retire - Agent Retirement", () => {
    it("should create a test agent first", async () => {
      const name = "Retire Test Agent";
      const totalSupply = 500_000;
      const onChainId = null;
      const message = `talos-genesis:${name}:${onChainId ?? "null"}:${totalSupply}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      const res = await api("/api/talos", {
        method: "POST",
        body: JSON.stringify({
          name,
          category: "Development",
          description: "Test agent for retirement feature",
          totalSupply,
          creatorPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
          agentName: "retire-test-agent",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      talosId = body.id;
      apiKey = body.apiKeyOnce;
      expect(body.agentName).toBe("retire-test-agent");
    });

    it("should retire an agent and preserve historical data", async () => {
      // Add some historical data first
      await db.insert(tlsActivities).values({
        talosId,
        type: "test",
        content: "Test activity before retirement",
        channel: "test",
        status: "completed",
      });

      await db.insert(tlsPatrons).values({
        talosId,
        stellarPublicKey: creatorKeypair.publicKey(),
        role: "Creator",
        pulseAmount: 1000,
        share: "10.00",
        status: "active",
      });

      // Retire the agent
      const message = `Retire TALOS ${talosId}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");
      
      const res = await api(`/api/talos/${talosId}/retire`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Test retirement",
          supersededBy: null,
          stellarPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.retiredAt).toBeDefined();
      expect(body.retiredReason).toBe("Test retirement");
      expect(body.agentName).toBe("retire-test-agent");
    });

    it("should preserve historical data after retirement", async () => {
      // Check that activities still exist
      const activities = await db.query.tlsActivities.findMany({
        where: eq(tlsActivities.talosId, talosId),
      });
      expect(activities.length).toBeGreaterThan(0);
      expect(activities[0].content).toBe("Test activity before retirement");

      // Check that patrons still exist
      const patrons = await db.query.tlsPatrons.findMany({
        where: eq(tlsPatrons.talosId, talosId),
      });
      expect(patrons.length).toBeGreaterThan(0);
      expect(patrons[0].role).toBe("Creator");
    });

    it("should prevent retiring an already retired agent", async () => {
      const message = `Double retirement attempt ${talosId}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");
      
      const res = await api(`/api/talos/${talosId}/retire`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Double retirement attempt",
          stellarPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("TALOS already retired");
    });

    it("should prevent agentName reuse after retirement", async () => {
      const name = "Retire Test Agent 2";
      const totalSupply = 500_000;
      const onChainId = null;
      const message = `talos-genesis:${name}:${onChainId ?? "null"}:${totalSupply}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      // Try to create a new agent with the same agentName
      const res = await api("/api/talos", {
        method: "POST",
        body: JSON.stringify({
          name,
          category: "Development",
          description: "Should fail due to name reuse",
          totalSupply,
          creatorPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
          agentName: "retire-test-agent", // Same name as retired agent
        }),
      });

      // This should fail due to unique constraint violation
      expect(res.status).toBe(409); // Conflict
    });
  });

  describe("POST /api/talos/:id/delete - Privacy Deletion", () => {
    it("should create another test agent for deletion test", async () => {
      const name = "Delete Test Agent";
      const totalSupply = 500_000;
      const onChainId = null;
      const message = `talos-genesis:${name}:${onChainId ?? "null"}:${totalSupply}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      const res = await api("/api/talos", {
        method: "POST",
        body: JSON.stringify({
          name,
          category: "Development",
          description: "Test agent for deletion feature",
          totalSupply,
          creatorPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
          agentName: "delete-test-agent",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      talosId = body.id;
      expect(body.agentName).toBe("delete-test-agent");
    });

    it("should soft delete an agent and clear sensitive fields", async () => {
      // Add some data first
      await db.insert(tlsActivities).values({
        talosId,
        type: "test",
        content: "Test activity before deletion",
        channel: "test",
        status: "completed",
      });

      const message = `Delete TALOS ${talosId}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      const res = await api(`/api/talos/${talosId}/delete`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Privacy deletion requested",
          stellarPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deletedAt).toBeDefined();
      expect(body.deletedReason).toBe("Privacy deletion requested");
      expect(body.message).toContain("preserved");
    });

    it("should clear sensitive fields but preserve identity", async () => {
      const talos = await db.query.tlsTalos.findFirst({
        where: eq(tlsTalos.id, talosId),
      });

      expect(talos).toBeDefined();
      expect(talos!.deletedAt).toBeDefined();
      expect(talos!.apiKey).toBeNull();
      expect(talos!.agentWalletId).toBeNull();
      expect(talos!.agentWalletAddress).toBeNull();
      expect(talos!.walletPublicKey).toBeNull();
      expect(talos!.creatorPublicKey).toBeNull();
      // Identity fields should be preserved
      expect(talos!.id).toBe(talosId);
      expect(talos!.agentName).toBe("delete-test-agent");
      expect(talos!.name).toBe("Delete Test Agent");
    });

    it("should preserve historical links after soft deletion", async () => {
      // Check that activities still exist
      const activities = await db.query.tlsActivities.findMany({
        where: eq(tlsActivities.talosId, talosId),
      });
      expect(activities.length).toBeGreaterThan(0);
      expect(activities[0].content).toBe("Test activity before deletion");
    });

    it("should prevent deleting an already deleted agent", async () => {
      const message = `Double deletion attempt ${talosId}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      const res = await api(`/api/talos/${talosId}/delete`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Double deletion attempt",
          stellarPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("TALOS already deleted");
    });
  });

  describe("Historical Data Querying", () => {
    it("should allow querying retired agent data", async () => {
      // Query the retired agent
      const res = await api(`/api/talos/${talosId}`);
      
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(talosId);
      expect(body.deletedAt).toBeDefined();
      expect(body.agentName).toBe("delete-test-agent");
    });

    it("should include retirement status in agent queries", async () => {
      // Create and retire an agent
      const name = "Status Test Agent";
      const totalSupply = 500_000;
      const onChainId = null;
      const message = `talos-genesis:${name}:${onChainId ?? "null"}:${totalSupply}`;
      const signature = creatorKeypair.sign(Buffer.from(message, "utf-8")).toString("base64");

      const createRes = await api("/api/talos", {
        method: "POST",
        body: JSON.stringify({
          name,
          category: "Development",
          description: "Test agent for status query",
          totalSupply,
          creatorPublicKey: creatorKeypair.publicKey(),
          signature,
          message,
          agentName: "status-test-agent",
        }),
      });

      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      const statusTestId = createBody.id;

      // Retire it
      const retireMessage = `Retire TALOS ${statusTestId}`;
      const retireSignature = creatorKeypair.sign(Buffer.from(retireMessage, "utf-8")).toString("base64");
      
      await api(`/api/talos/${statusTestId}/retire`, {
        method: "POST",
        body: JSON.stringify({ 
          reason: "Status test",
          stellarPublicKey: creatorKeypair.publicKey(),
          signature: retireSignature,
          message: retireMessage,
        }),
      });

      // Query it
      const queryRes = await api(`/api/talos/${statusTestId}`);
      expect(queryRes.status).toBe(200);
      const queryBody = await queryRes.json();
      expect(queryBody.retiredAt).toBeDefined();
      expect(queryBody.status).toBe("Retired");
    });
  });
});
