/**
 * Unit tests for the OpenAPI schema additions introduced by issue #508:
 * admin job endpoints (`/api/admin/jobs` and sub-paths).
 *
 * These tests verify the spec structure independently of the snapshot so that
 * structural regressions produce actionable, targeted failures rather than a
 * large diff against the full JSON fixture.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../src/lib/openapi";

// ── Helpers ────────────────────────────────────────────────────────────────

type Spec = typeof openApiSpec;
type PathKey = keyof (Spec & { paths: Record<string, unknown> })["paths"];

function getPath(path: PathKey) {
  return (openApiSpec as unknown as { paths: Record<string, unknown> }).paths[path];
}

function getSchema(name: string) {
  return (openApiSpec as unknown as { components: { schemas: Record<string, unknown> } })
    .components.schemas[name];
}

function getSecurityScheme(name: string) {
  return (
    openApiSpec as unknown as {
      components: { securitySchemes: Record<string, unknown> };
    }
  ).components.securitySchemes[name];
}

// ── Tag registration ───────────────────────────────────────────────────────

describe("Admin — Jobs tag", () => {
  it("is registered in the top-level tags array", () => {
    const tag = (openApiSpec.tags as Array<{ name: string; description: string }>).find(
      (t) => t.name === "Admin — Jobs",
    );
    expect(tag).toBeDefined();
    expect(tag?.description).toContain("ADMIN_API_KEY");
  });
});

// ── Security scheme ────────────────────────────────────────────────────────

describe("AdminAuth security scheme", () => {
  it("exists in components.securitySchemes", () => {
    const scheme = getSecurityScheme("AdminAuth");
    expect(scheme).toBeDefined();
  });

  it("is HTTP bearer type", () => {
    const scheme = getSecurityScheme("AdminAuth") as {
      type: string;
      scheme: string;
      description: string;
    };
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
  });

  it("description mentions ADMIN_API_KEY and the error codes", () => {
    const scheme = getSecurityScheme("AdminAuth") as { description: string };
    expect(scheme.description).toContain("ADMIN_API_KEY");
    expect(scheme.description).toContain("401");
    expect(scheme.description).toContain("403");
    expect(scheme.description).toContain("500");
  });
});

// ── AdminJobRecord schema ──────────────────────────────────────────────────

describe("AdminJobRecord schema", () => {
  it("exists in components.schemas", () => {
    expect(getSchema("AdminJobRecord")).toBeDefined();
  });

  it("requires the core fields", () => {
    const schema = getSchema("AdminJobRecord") as { required: string[] };
    const required = new Set(schema.required);
    for (const field of ["id", "queue", "status", "attempts", "maxAttempts", "createdAt"]) {
      expect(required, `field '${field}' should be required`).toContain(field);
    }
  });

  it("status enum covers all five job states", () => {
    const schema = getSchema("AdminJobRecord") as {
      properties: { status: { enum: string[] } };
    };
    expect(schema.properties.status.enum.sort()).toEqual(
      ["cancelled", "completed", "dead_letter", "leased", "pending"].sort(),
    );
  });

  it("retryClass enum covers all three classes", () => {
    const schema = getSchema("AdminJobRecord") as {
      properties: { retryClass: { enum: string[] } };
    };
    expect(schema.properties.retryClass.enum.sort()).toEqual(
      ["fatal", "rate_limited", "transient"].sort(),
    );
  });

  it("date-time fields use the correct format", () => {
    const schema = getSchema("AdminJobRecord") as {
      properties: Record<string, { format?: string }>;
    };
    for (const field of ["runAt", "createdAt", "updatedAt"]) {
      expect(
        schema.properties[field]?.format,
        `field '${field}' should have format: date-time`,
      ).toBe("date-time");
    }
  });
});

// ── GET /api/admin/jobs ────────────────────────────────────────────────────

describe("GET /api/admin/jobs", () => {
  const route = getPath("/api/admin/jobs") as {
    get: {
      operationId: string;
      tags: string[];
      security: Array<Record<string, unknown[]>>;
      parameters: Array<{ name: string; in: string; schema: Record<string, unknown> }>;
      responses: Record<string, unknown>;
    };
  };

  it("exists in paths", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
  });

  it("has operationId adminListJobs", () => {
    expect(route.get.operationId).toBe("adminListJobs");
  });

  it("is tagged Admin — Jobs", () => {
    expect(route.get.tags).toContain("Admin — Jobs");
  });

  it("requires AdminAuth", () => {
    expect(route.get.security).toEqual(expect.arrayContaining([{ AdminAuth: [] }]));
  });

  it("declares status query parameter with correct enum", () => {
    const statusParam = route.get.parameters.find((p) => p.name === "status");
    expect(statusParam).toBeDefined();
    expect(statusParam?.in).toBe("query");
    expect((statusParam?.schema as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(["pending", "leased", "completed", "dead_letter", "cancelled"]),
    );
  });

  it("declares queue, cursor, limit query parameters", () => {
    const names = new Set(route.get.parameters.map((p) => p.name));
    expect(names.has("queue")).toBe(true);
    expect(names.has("cursor")).toBe(true);
    expect(names.has("limit")).toBe(true);
  });

  it("responds 200 with jobs array and nextCursor", () => {
    const ok = route.get.responses["200"] as {
      content: {
        "application/json": {
          schema: { properties: { jobs: unknown; nextCursor: unknown } };
        };
      };
    };
    expect(ok).toBeDefined();
    expect(ok.content["application/json"].schema.properties.jobs).toBeDefined();
    expect(ok.content["application/json"].schema.properties.nextCursor).toBeDefined();
  });

  it("documents 400 for bad status value", () => {
    expect(route.get.responses["400"]).toBeDefined();
  });

  it("documents 401, 403, 500 auth-related errors", () => {
    expect(route.get.responses["401"]).toBeDefined();
    expect(route.get.responses["403"]).toBeDefined();
    expect(route.get.responses["500"]).toBeDefined();
  });
});

// ── GET /api/admin/jobs/{id} ───────────────────────────────────────────────

describe("GET /api/admin/jobs/{id}", () => {
  const route = getPath("/api/admin/jobs/{id}") as {
    get: {
      operationId: string;
      tags: string[];
      security: Array<Record<string, unknown[]>>;
      parameters: Array<{ name: string; in: string }>;
      responses: Record<string, unknown>;
    };
  };

  it("exists in paths", () => {
    expect(route).toBeDefined();
    expect(route.get).toBeDefined();
  });

  it("has operationId adminGetJob", () => {
    expect(route.get.operationId).toBe("adminGetJob");
  });

  it("is tagged Admin — Jobs and requires AdminAuth", () => {
    expect(route.get.tags).toContain("Admin — Jobs");
    expect(route.get.security).toEqual(expect.arrayContaining([{ AdminAuth: [] }]));
  });

  it("declares a required path param 'id'", () => {
    const idParam = route.get.parameters.find((p) => p.name === "id");
    expect(idParam).toBeDefined();
    expect(idParam?.in).toBe("path");
  });

  it("responds 200 with AdminJobRecord schema ref", () => {
    const ok = route.get.responses["200"] as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/AdminJobRecord");
  });

  it("documents 404 and 401/403/500", () => {
    expect(route.get.responses["404"]).toBeDefined();
    expect(route.get.responses["401"]).toBeDefined();
    expect(route.get.responses["403"]).toBeDefined();
    expect(route.get.responses["500"]).toBeDefined();
  });
});

// ── POST /api/admin/jobs/{id}/retry ───────────────────────────────────────

describe("POST /api/admin/jobs/{id}/retry", () => {
  const route = getPath("/api/admin/jobs/{id}/retry") as {
    post: {
      operationId: string;
      tags: string[];
      security: Array<Record<string, unknown[]>>;
      responses: Record<string, unknown>;
    };
  };

  it("exists in paths", () => {
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
  });

  it("has operationId adminRetryJob", () => {
    expect(route.post.operationId).toBe("adminRetryJob");
  });

  it("is tagged Admin — Jobs and requires AdminAuth", () => {
    expect(route.post.tags).toContain("Admin — Jobs");
    expect(route.post.security).toEqual(expect.arrayContaining([{ AdminAuth: [] }]));
  });

  it("responds 200 with AdminJobRecord schema ref", () => {
    const ok = route.post.responses["200"] as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/AdminJobRecord");
  });

  it("documents 409 for non-retryable state", () => {
    const conflict = route.post.responses["409"] as {
      description: string;
      content: {
        "application/json": {
          schema: { properties: { error: { type: string } } };
        };
      };
    };
    expect(conflict).toBeDefined();
    expect(conflict.description).toMatch(/retryable/i);
  });

  it("documents 404, 401, 403, 500", () => {
    expect(route.post.responses["404"]).toBeDefined();
    expect(route.post.responses["401"]).toBeDefined();
    expect(route.post.responses["403"]).toBeDefined();
    expect(route.post.responses["500"]).toBeDefined();
  });
});

// ── POST /api/admin/jobs/{id}/cancel ──────────────────────────────────────

describe("POST /api/admin/jobs/{id}/cancel", () => {
  const route = getPath("/api/admin/jobs/{id}/cancel") as {
    post: {
      operationId: string;
      tags: string[];
      security: Array<Record<string, unknown[]>>;
      responses: Record<string, unknown>;
    };
  };

  it("exists in paths", () => {
    expect(route).toBeDefined();
    expect(route.post).toBeDefined();
  });

  it("has operationId adminCancelJob", () => {
    expect(route.post.operationId).toBe("adminCancelJob");
  });

  it("is tagged Admin — Jobs and requires AdminAuth", () => {
    expect(route.post.tags).toContain("Admin — Jobs");
    expect(route.post.security).toEqual(expect.arrayContaining([{ AdminAuth: [] }]));
  });

  it("responds 200 with AdminJobRecord schema ref", () => {
    const ok = route.post.responses["200"] as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/AdminJobRecord");
  });

  it("documents 409 for non-cancellable state", () => {
    const conflict = route.post.responses["409"] as {
      description: string;
    };
    expect(conflict).toBeDefined();
    expect(conflict.description).toMatch(/cancell/i);
  });

  it("documents 404, 401, 403, 500", () => {
    expect(route.post.responses["404"]).toBeDefined();
    expect(route.post.responses["401"]).toBeDefined();
    expect(route.post.responses["403"]).toBeDefined();
    expect(route.post.responses["500"]).toBeDefined();
  });
});

// ── Regression: existing paths are unaffected ──────────────────────────────

describe("Regression: existing paths still present", () => {
  it("/api/talos still exists", () => {
    expect(getPath("/api/talos")).toBeDefined();
  });

  it("/api/jobs/pending still exists", () => {
    expect(getPath("/api/jobs/pending")).toBeDefined();
  });

  it("BearerAuth security scheme is still present", () => {
    expect(getSecurityScheme("BearerAuth")).toBeDefined();
  });
});
