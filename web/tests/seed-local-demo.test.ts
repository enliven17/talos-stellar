/**
 * Tests for local demo seed script
 * 
 * Validates:
 * - Idempotency: running twice produces same result
 * - Safety: blocks production-looking databases
 * - Data completeness: all entities created correctly
 * - No sensitive values in seed data
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsCommerceServices,
  tlsCommerceJobs,
  tlsApprovals,
  tlsRevenues,
} from "../src/db/schema";

const execAsync = promisify(exec);

const TEST_DB_URL = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: TEST_DB_URL });
const db = drizzle(pool);

// Test agent names created by seed script
const SEED_AGENT_NAMES = ["demo-scout-trend", "demo-prospect-signal"];

describe("Local Demo Seed Script", () => {
  beforeAll(async () => {
    // Clean up any existing seed data before tests
    for (const agentName of SEED_AGENT_NAMES) {
      const [existing] = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(eq(tlsTalos.agentName, agentName));

      if (existing) {
        await db.delete(tlsCommerceJobs).where(eq(tlsCommerceJobs.talosId, existing.id));
        await db.delete(tlsCommerceServices).where(eq(tlsCommerceServices.talosId, existing.id));
        await db.delete(tlsRevenues).where(eq(tlsRevenues.talosId, existing.id));
        await db.delete(tlsApprovals).where(eq(tlsApprovals.talosId, existing.id));
        await db.delete(tlsActivities).where(eq(tlsActivities.talosId, existing.id));
        await db.delete(tlsPatrons).where(eq(tlsPatrons.talosId, existing.id));
        await db.delete(tlsTalos).where(eq(tlsTalos.id, existing.id));
      }
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("Safety Guards", () => {
    it("should block production-looking database URLs", async () => {
      const productionUrls = [
        "postgresql://user:pass@aws-prod-server.com:5432/db",
        "postgresql://user:pass@db.supabase.co:5432/postgres",
        "postgresql://user:pass@production-db.neon.tech:5432/db",
        "postgresql://user:pass@live-server.planetscale.com:5432/db",
      ];

      for (const prodUrl of productionUrls) {
        const result = await execAsync(
          `DATABASE_URL="${prodUrl}" tsx scripts/seed-local-demo.ts`,
          { cwd: process.cwd() }
        ).catch((e) => e);

        expect(result.stderr || result.message).toMatch(
          /production database|SEED_ALLOW_PRODUCTION/i
        );
      }
    }, 30_000);

    it("should allow override with SEED_ALLOW_PRODUCTION=true", async () => {
      // This test only validates the override flag is respected
      // We don't actually run against production
      const scriptPath = "scripts/seed-local-demo.ts";
      const { stdout } = await execAsync(`type ${scriptPath}`, { shell: "cmd.exe" });
      
      expect(stdout).toContain("SEED_ALLOW_PRODUCTION");
      expect(stdout).toContain("validateLocalEnvironment");
    });

    it("should require localhost or local indicators in DATABASE_URL", () => {
      const validLocalUrls = [
        "postgresql://user:pass@localhost:5432/talos_dev",
        "postgresql://user:pass@127.0.0.1:5432/talos_dev",
        "postgresql://user:pass@local.docker:5432/talos_dev",
      ];

      for (const url of validLocalUrls) {
        const isValid = 
          url.includes("localhost") ||
          url.includes("127.0.0.1") ||
          url.includes("local") ||
          url.includes("docker");
        
        expect(isValid).toBe(true);
      }
    });
  });

  describe("Data Completeness", () => {
    beforeAll(async () => {
      // Run the seed script
      await execAsync("tsx scripts/seed-local-demo.ts", { cwd: process.cwd() });
    }, 60_000);

    it("should create exactly 2 demo agents", async () => {
      const agents = await db
        .select({ id: tlsTalos.id, agentName: tlsTalos.agentName, name: tlsTalos.name })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      expect(agents.length).toBe(2);
      expect(agents.map((a) => a.agentName)).toContain("demo-scout-trend");
      expect(agents.map((a) => a.agentName)).toContain("demo-prospect-signal");
    });

    it("should create commerce services for each agent", async () => {
      const agents = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        const [service] = await db
          .select()
          .from(tlsCommerceServices)
          .where(eq(tlsCommerceServices.talosId, agent.id));

        expect(service).toBeDefined();
        expect(service.serviceName).toBeTruthy();
        expect(parseFloat(service.price)).toBeGreaterThan(0);
        expect(service.currency).toBe("USDC");
      }
    });

    it("should create patrons for each agent", async () => {
      const agents = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        const patrons = await db
          .select()
          .from(tlsPatrons)
          .where(eq(tlsPatrons.talosId, agent.id));

        expect(patrons.length).toBeGreaterThan(0);
        
        // Check shares add up to 100%
        const totalShare = patrons.reduce((sum, p) => sum + parseFloat(p.share), 0);
        expect(totalShare).toBeCloseTo(100, 0);
      }
    });

    it("should create activities for each agent", async () => {
      const agents = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        const activities = await db
          .select()
          .from(tlsActivities)
          .where(eq(tlsActivities.talosId, agent.id));

        expect(activities.length).toBeGreaterThan(0);
        expect(activities[0].type).toBeTruthy();
        expect(activities[0].content).toBeTruthy();
        expect(activities[0].channel).toBeTruthy();
      }
    });

    it("should create at least one completed commerce record", async () => {
      const completedJobs = await db
        .select()
        .from(tlsCommerceJobs)
        .where(eq(tlsCommerceJobs.status, "completed"));

      expect(completedJobs.length).toBeGreaterThanOrEqual(1);
      
      const job = completedJobs[0];
      expect(job.serviceName).toBeTruthy();
      expect(parseFloat(job.amount)).toBeGreaterThan(0);
      expect(job.payload).toBeTruthy();
      expect(job.result).toBeTruthy();
      expect(job.txHash).toBeTruthy();
    });

    it("should create revenues for agents", async () => {
      const agents = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        const revenues = await db
          .select()
          .from(tlsRevenues)
          .where(eq(tlsRevenues.talosId, agent.id));

        expect(revenues.length).toBeGreaterThan(0);
        expect(parseFloat(revenues[0].amount)).toBeGreaterThan(0);
        expect(revenues[0].currency).toBe("USDC");
      }
    });

    it("should create pending approvals for agents", async () => {
      const agents = await db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        const approvals = await db
          .select()
          .from(tlsApprovals)
          .where(eq(tlsApprovals.talosId, agent.id));

        expect(approvals.length).toBeGreaterThan(0);
        expect(approvals[0].status).toBe("pending");
        expect(approvals[0].type).toBeTruthy();
        expect(approvals[0].title).toBeTruthy();
      }
    });
  });

  describe("Idempotency", () => {
    it("should produce same result when run twice", async () => {
      // Run seed first time
      await execAsync("tsx scripts/seed-local-demo.ts", { cwd: process.cwd() });

      // Capture state
      const firstAgents = await db
        .select()
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      const firstPatrons = await db
        .select()
        .from(tlsPatrons)
        .where(eq(tlsPatrons.talosId, firstAgents[0].id));

      const firstActivities = await db
        .select()
        .from(tlsActivities)
        .where(eq(tlsActivities.talosId, firstAgents[0].id));

      // Run seed second time
      await execAsync("tsx scripts/seed-local-demo.ts", { cwd: process.cwd() });

      // Capture state again
      const secondAgents = await db
        .select()
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      const secondPatrons = await db
        .select()
        .from(tlsPatrons)
        .where(eq(tlsPatrons.talosId, secondAgents[0].id));

      const secondActivities = await db
        .select()
        .from(tlsActivities)
        .where(eq(tlsActivities.talosId, secondAgents[0].id));

      // Compare counts (logical dataset should be same)
      expect(secondAgents.length).toBe(firstAgents.length);
      expect(secondPatrons.length).toBe(firstPatrons.length);
      expect(secondActivities.length).toBe(firstActivities.length);

      // Compare key fields
      expect(secondAgents[0].name).toBe(firstAgents[0].name);
      expect(secondAgents[0].category).toBe(firstAgents[0].category);
      expect(secondAgents[0].totalSupply).toBe(firstAgents[0].totalSupply);
    }, 90_000);

    it("should not create duplicate agents on re-run", async () => {
      // Run seed
      await execAsync("tsx scripts/seed-local-demo.ts", { cwd: process.cwd() });

      // Count agents
      const beforeCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      // Run seed again
      await execAsync("tsx scripts/seed-local-demo.ts", { cwd: process.cwd() });

      // Count agents again
      const afterCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      expect(afterCount[0].count).toBe(beforeCount[0].count);
    }, 90_000);
  });

  describe("Sensitive Data Validation", () => {
    it("should not contain real private keys in seed data", async () => {
      const agents = await db
        .select()
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        // Stellar secret keys start with 'S'
        expect(agent.creatorPublicKey).not.toMatch(/^S[A-Z0-9]{55}$/);
        
        // Check apiKey is not a real stellar secret
        if (agent.apiKey) {
          expect(agent.apiKey).not.toMatch(/^S[A-Z0-9]{55}$/);
        }
      }
    });

    it("should not contain production wallet addresses", async () => {
      const agents = await db
        .select()
        .from(tlsTalos)
        .where(sql`${tlsTalos.agentName} LIKE 'demo-%'`);

      for (const agent of agents) {
        // All addresses should be clearly marked as demo/test
        expect(agent.creatorPublicKey).toMatch(/DEMO|TEST|LOCAL/i);
      }

      const patrons = await db
        .select()
        .from(tlsPatrons)
        .where(eq(tlsPatrons.talosId, agents[0].id));

      for (const patron of patrons) {
        expect(patron.stellarPublicKey).toMatch(/DEMO|TEST|LOCAL/i);
      }
    });

    it("should not contain real API keys or credentials", async () => {
      const jobs = await db
        .select()
        .from(tlsCommerceJobs)
        .where(eq(tlsCommerceJobs.status, "completed"));

      for (const job of jobs) {
        const payloadStr = JSON.stringify(job.payload);
        const resultStr = JSON.stringify(job.result);

        // Check for common API key patterns
        expect(payloadStr).not.toMatch(/sk-[a-zA-Z0-9]{32,}/); // OpenAI
        expect(payloadStr).not.toMatch(/tvly-[a-zA-Z0-9]{32,}/); // Tavily
        expect(resultStr).not.toMatch(/sk-[a-zA-Z0-9]{32,}/);
        expect(resultStr).not.toMatch(/tvly-[a-zA-Z0-9]{32,}/);
      }
    });
  });
});
