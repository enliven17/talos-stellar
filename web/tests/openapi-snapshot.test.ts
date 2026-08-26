import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/docs/openapi.json/route";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXCLUDED_ROUTES = [
  "/api/docs",
  "/api/docs/openapi.json",
  "/api/health",
  "/api/health/live",
  "/api/health/ready",
  "/api/internal/jobs/drain",
  "/api/internal/outbox/drain",
  "/api/ops/backup",
  "/api/ops/backup/status",
  "/api/ops/restore",
  "/api/admin/jobs",
  "/api/admin/jobs/{id}",
  "/api/admin/jobs/{id}/cancel",
  "/api/admin/jobs/{id}/retry",
  "/api/admin/outbox",
  "/api/admin/outbox/{id}",
  "/api/admin/outbox/{id}/retry",
  "/api/webhooks/subscriptions",
  "/api/webhooks/subscriptions/{id}",
  "/api/webhooks/deliveries",
  "/api/webhooks/deliveries/{id}/result",
  "/api/webhooks/deliveries/{id}/heartbeat",
  "/api/webhooks/deliveries/{id}/claim",
  "/api/webhooks/deliveries/pending",
  "/api/talos/{id}/retire",
  "/api/talos/{id}/reputation",
  "/api/talos/{id}/quota",
  "/api/talos/{id}/lifecycle",
  "/api/talos/{id}/exposure",
  "/api/talos/{id}/exposure/alerts",
  "/api/talos/{id}/delete",
  "/api/talos/{id}/credit-score",
  "/api/talos/{id}/audit/verify",
  "/api/talos/{id}/audit/checkpoint",
  "/api/talos/{id}/api-keys",
  "/api/talos/{id}/api-keys/{keyId}",
  "/api/proposals",
  "/api/jobs/{id}/release",
  "/api/jobs/{id}/heartbeat",
  "/api/jobs/{id}/claim",
  "/api/ecosystem-intelligence",
];

describe("OpenAPI snapshot", () => {
  it("matches the JSON served by /api/docs/openapi.json", async () => {
    const response = GET();
    const spec = await response.json();
    const actual = `${JSON.stringify(spec, null, 2)}\n`;
    const expected = await readFile(
      path.resolve(__dirname, "fixtures/openapi.snapshot.json"),
      "utf8",
    );

    // Normalize line endings to handle Windows CRLF vs Unix LF
    const normalizeLineEndings = (str: string) =>
      str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    expect(normalizeLineEndings(actual)).toEqual(
      normalizeLineEndings(expected),
    );
  });

  it("has no drift between filesystem API routes and OpenAPI snapshot", async () => {
    const apiDir = path.resolve(__dirname, "../src/app/api");
    const allFiles = await readdir(apiDir, { recursive: true });
    const routeFiles = allFiles.filter((f) => f.endsWith("route.ts"));

    const fsRoutes = new Set<string>();

    for (const file of routeFiles) {
      // Map Windows backslashes to forward slashes for cross-platform support
      let routePath = "/api/" + file
        .replace(/\\/g, "/")
        .replace(/\/route\.ts$/, "")
        .replace(/route\.ts$/, "")
        .replace(/\[([^\]]+)\]/g, "{$1}");

      if (routePath.endsWith("/") && routePath !== "/") {
        routePath = routePath.slice(0, -1);
      }
      fsRoutes.add(routePath);
    }

    const expected = await readFile(
      path.resolve(__dirname, "fixtures/openapi.snapshot.json"),
      "utf8",
    );
    const spec = JSON.parse(expected);
    const specPaths = Object.keys(spec.paths);

    const missingFromSpec: string[] = [];
    const staleInSpec: string[] = [];

    for (const route of fsRoutes) {
      if (EXCLUDED_ROUTES.includes(route)) continue;
      if (!spec.paths[route]) {
        missingFromSpec.push(route);
      }
    }

    for (const route of specPaths) {
      if (!fsRoutes.has(route)) {
        staleInSpec.push(route);
      }
    }

    expect(
      missingFromSpec,
      "Found API routes implemented in code but missing from OpenAPI snapshot. Please document them in openapi.ts or add them to EXCLUDED_ROUTES in the test.",
    ).toEqual([]);

    expect(
      staleInSpec,
      "Found API routes documented in OpenAPI snapshot but missing from code. Please remove them from openapi.ts.",
    ).toEqual([]);
  });
});
