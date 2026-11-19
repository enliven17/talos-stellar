/**
 * Compile-time type checking test for generated OpenAPI types.
 * This file validates that the generated types match expected API structures.
 * 
 * This test is designed to fail at compile-time if the generated types
 * are incorrect or out of sync with the OpenAPI specification.
 */

import { describe, it, expect } from "vitest";
import type { paths, components, operations } from "../src/generated-types.js";

describe("Generated OpenAPI types", () => {
  it("should have correct type structure for key API paths", () => {
    // Test that key API paths exist and have correct structure
    type ListTalosPath = paths["/api/talos"]["get"];
    type CreateTalosPath = paths["/api/talos"]["post"];
    type GetTalosPath = paths["/api/talos/{id}"]["get"];

    // Test that response types are correctly defined
    type ListTalosResponse = ListTalosPath["responses"]["200"]["content"]["application/json"];
    type CreateTalosResponse = CreateTalosPath["responses"]["201"]["content"]["application/json"];
    type GetTalosResponse = GetTalosPath["responses"]["200"]["content"]["application/json"];

    // Test that request body types are correctly defined
    type CreateTalosRequestBody = CreateTalosPath["requestBody"]["content"]["application/json"];

    // Test that component schemas exist
    type TalosSchema = components["schemas"]["TalosListItem"];
    type TalosDetailSchema = components["schemas"]["TalosDetail"];
    type CreateTalosRequestSchema = components["schemas"]["CreateTalosRequest"];

    // If this compiles, the types exist and have the expected structure
    expect(true).toBe(true);
  });

  it("should have apiKeyOnce field in CreateTalosResponse", () => {
    type CreateTalosResponse = paths["/api/talos"]["post"]["responses"]["201"]["content"]["application/json"];
    
    // This will fail to compile if apiKeyOnce doesn't exist
    const test: CreateTalosResponse = {
      id: "test",
      name: "test",
      category: "Marketing",
      description: "test",
      status: "Active",
      pulsePrice: "0.05",
      totalSupply: 1000000,
      creatorShare: 0,
      investorShare: 25,
      treasuryShare: 75,
      channels: [],
      approvalThreshold: "10",
      gtmBudget: "200",
      agentOnline: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      apiKeyOnce: "tak_test", // This field must exist
    };
    
    expect(test.apiKeyOnce).toBe("tak_test");
  });

  it("should have required fields in CreateTalosRequest", () => {
    type CreateTalosRequestBody = paths["/api/talos"]["post"]["requestBody"]["content"]["application/json"];
    
    const test: CreateTalosRequestBody = {
      name: "test",
      category: "Marketing",
      description: "test",
      totalSupply: 1000000,
      channels: [],
      approvalThreshold: 10,
      gtmBudget: 200,
      initialPrice: 0,
    };
    
    expect(test.name).toBe("test");
    expect(test.category).toBe("Marketing");
    expect(test.description).toBe("test");
  });

  it("should have expected fields in TalosListItem schema", () => {
    type TalosSchema = components["schemas"]["TalosListItem"];
    
    const test: TalosSchema = {
      id: "test",
      name: "test",
      category: "Marketing",
      description: "test",
      status: "Active",
      pulsePrice: "0.05",
      totalSupply: 1000000,
      creatorShare: 0,
      investorShare: 25,
      treasuryShare: 75,
      channels: [],
      approvalThreshold: "10",
      gtmBudget: "200",
      agentOnline: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    
    expect(test.id).toBe("test");
    expect(test.name).toBe("test");
    expect(test.category).toBe("Marketing");
  });
});
