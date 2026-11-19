import { describe, it, expect } from "vitest";
import { planMigration, TalosRow } from "../scripts/migrate-legacy-keys";

describe("planMigration", () => {
  it("should plan migration for rows with valid API keys", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_test_key_1" },
      { id: "talos-2", apiKey: "tak_test_key_2" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(2);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
    expect(plan.toMigrate[0].talosId).toBe("talos-1");
    expect(plan.toMigrate[0].keyHash).toBeDefined();
    expect(plan.toMigrate[1].talosId).toBe("talos-2");
    expect(plan.toMigrate[1].keyHash).toBeDefined();
  });

  it("should skip rows with null API keys and add to errors", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_test_key_1" },
      { id: "talos-2", apiKey: null },
      { id: "talos-3", apiKey: "tak_test_key_3" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(2);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].talosId).toBe("talos-2");
    expect(plan.errors[0].error).toBe("apiKey is null");
  });

  it("should handle empty input", () => {
    const rows: TalosRow[] = [];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
  });

  it("should handle all null API keys", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: null },
      { id: "talos-2", apiKey: null },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(0);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(2);
  });

  it("should generate different hashes for different keys", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_key_a" },
      { id: "talos-2", apiKey: "tak_key_b" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate[0].keyHash).not.toBe(plan.toMigrate[1].keyHash);
  });

  it("should generate same hash for same key", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_same_key" },
      { id: "talos-2", apiKey: "tak_same_key" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate[0].keyHash).toBe(plan.toMigrate[1].keyHash);
  });

  it("should handle mixed migrated and unmigrated rows", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_key_1" },
      { id: "talos-2", apiKey: null },
      { id: "talos-3", apiKey: "tak_key_3" },
      { id: "talos-4", apiKey: "tak_key_4" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(3);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].talosId).toBe("talos-2");
  });

  it("should handle empty string API key", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "" },
    ];

    const plan = planMigration(rows);

    expect(plan.toMigrate).toHaveLength(1);
    expect(plan.toSkip).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
    expect(plan.toMigrate[0].keyHash).toBeDefined();
  });

  it("should not include key material in plan output", () => {
    const rows: TalosRow[] = [
      { id: "talos-1", apiKey: "tak_secret_key_123" },
      { id: "talos-2", apiKey: "tak_another_secret" },
    ];

    const plan = planMigration(rows);

    // Check that the raw keys are not in the plan
    const planJson = JSON.stringify(plan);
    expect(planJson).not.toContain("tak_secret_key_123");
    expect(planJson).not.toContain("tak_another_secret");
    expect(planJson).toContain("keyHash");
  });
});
