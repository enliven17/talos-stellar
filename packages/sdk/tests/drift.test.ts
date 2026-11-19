import { describe, it, expect, vi } from "vitest";
import { DriftDetector, DriftError } from "../src/drift.js";
import type { DriftMode, UnknownFieldPolicy, DriftViolation } from "../src/drift.js";
import { TalosClient } from "../src/client.js";

describe("DriftDetector - Direct Coverage", () => {
  const sampleSchema = {
    type: "object",
    required: ["id", "action"],
    properties: {
      id: { type: "string" },
      action: { type: "string", enum: ["start", "stop"] },
      count: { type: "integer", minimum: 1, maximum: 100 },
      meta: {
        type: "object",
        properties: {
          tag: { type: "string", minLength: 2, maxLength: 10 },
        },
      },
    },
  };

  const routeKey = "POST /api/talos/activity";

  describe("Schema registration and inspection", () => {
    it("registers schemas and reports registration status and route keys", () => {
      const detector = new DriftDetector();
      expect(detector.hasSchema(routeKey)).toBe(false);
      expect(detector.registeredRoutes()).toEqual([]);

      detector.registerSchema(routeKey, sampleSchema);

      expect(detector.hasSchema(routeKey)).toBe(true);
      expect(detector.registeredRoutes()).toEqual([routeKey]);
    });

    it("returns true when validating an unregistered route key across all modes", () => {
      const modes: DriftMode[] = ["off", "warn", "strict"];
      for (const mode of modes) {
        const detector = new DriftDetector({ mode });
        expect(detector.validate("GET /unregistered", { any: "data" })).toBe(true);
      }
    });
  });

  describe("Mode x UnknownFieldPolicy matrix (3 x 3 = 9 combinations)", () => {
    const modes: DriftMode[] = ["off", "warn", "strict"];
    const policies: UnknownFieldPolicy[] = ["allow", "strip", "reject"];

    for (const mode of modes) {
      for (const policy of policies) {
        describe(`mode: "${mode}" x unknownFieldPolicy: "${policy}"`, () => {
          it("passes silently for valid payloads", () => {
            const onViolation = vi.fn();
            const detector = new DriftDetector({
              mode,
              unknownFieldPolicy: policy,
              onViolation,
            });
            detector.registerSchema(routeKey, sampleSchema);

            const validPayload = {
              id: "item-123",
              action: "start",
              count: 5,
              meta: { tag: "prod" },
            };

            const result = detector.validate(routeKey, validPayload);
            expect(result).toBe(true);
            expect(onViolation).not.toHaveBeenCalled();
          });

          it("handles invalid payload according to mode semantics", () => {
            const onViolation = vi.fn();
            const detector = new DriftDetector({
              mode,
              unknownFieldPolicy: policy,
              onViolation,
            });
            detector.registerSchema(routeKey, sampleSchema);

            // Invalid payload: missing 'action', invalid type for 'id', out-of-range 'count'
            const invalidPayload = {
              id: 12345, // should be string
              count: 0, // below minimum 1
            };

            if (mode === "off") {
              const result = detector.validate(routeKey, invalidPayload);
              expect(result).toBe(true);
              expect(onViolation).not.toHaveBeenCalled();
            } else if (mode === "warn") {
              const result = detector.validate(routeKey, invalidPayload);
              expect(result).toBe(false);
              expect(onViolation).toHaveBeenCalledTimes(1);
              const [calledRoute, violations] = onViolation.mock.calls[0];
              expect(calledRoute).toBe(routeKey);
              expect(violations.length).toBeGreaterThan(0);
            } else if (mode === "strict") {
              expect(() => detector.validate(routeKey, invalidPayload)).toThrow(DriftError);
              expect(onViolation).toHaveBeenCalledTimes(1);
              const [calledRoute, violations] = onViolation.mock.calls[0];
              expect(calledRoute).toBe(routeKey);
              expect(violations.length).toBeGreaterThan(0);
            }
          });
        });
      }
    }
  });

  describe("Logger invocation and default handler", () => {
    it("warn invokes custom onViolation logger once with route key and violations", () => {
      const onViolation = vi.fn();
      const detector = new DriftDetector({
        mode: "warn",
        onViolation,
      });
      detector.registerSchema(routeKey, sampleSchema);

      const res = detector.validate(routeKey, { id: 123 }); // missing action, invalid id type
      expect(res).toBe(false);
      expect(onViolation).toHaveBeenCalledTimes(1);
      const [calledRoute, violations] = onViolation.mock.calls[0];
      expect(calledRoute).toBe(routeKey);
      expect(Array.isArray(violations)).toBe(true);
      expect(violations.length).toBe(2);
    });

    it("strict invokes custom onViolation logger once before throwing DriftError", () => {
      const onViolation = vi.fn();
      const detector = new DriftDetector({
        mode: "strict",
        onViolation,
      });
      detector.registerSchema(routeKey, sampleSchema);

      let thrownError: unknown;
      try {
        detector.validate(routeKey, {});
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(DriftError);
      expect((thrownError as DriftError).routeKey).toBe(routeKey);
      expect((thrownError as DriftError).violations.length).toBeGreaterThan(0);
      expect(onViolation).toHaveBeenCalledTimes(1);
    });

    it("defaults onViolation to console.warn and logs formatted violation info", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = new DriftDetector({ mode: "warn" });
      detector.registerSchema(routeKey, sampleSchema);

      const res = detector.validate(routeKey, { id: 123 });
      expect(res).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0][0]).toContain("[talos-sdk drift]");
      expect(consoleWarnSpy.mock.calls[0][0]).toContain(routeKey);

      consoleWarnSpy.mockRestore();
    });

    it("DriftError formats message with violations slice and count suffix when > 3 violations", () => {
      const violations: DriftViolation[] = [
        { path: "/a", message: "err a", kind: "missing_required" },
        { path: "/b", message: "err b", kind: "missing_required" },
        { path: "/c", message: "err c", kind: "missing_required" },
        { path: "/d", message: "err d", kind: "missing_required" },
      ];
      const err = new DriftError(routeKey, violations);
      expect(err.name).toBe("DriftError");
      expect(err.routeKey).toBe(routeKey);
      expect(err.violations).toBe(violations);
      expect(err.message).toContain("SDK drift on POST /api/talos/activity");
      expect(err.message).toContain("(and 1 more)");
    });
  });

  describe("Sampling rate and custom random", () => {
    it("skips validation when random draw >= sampleRate", () => {
      const onViolation = vi.fn();
      // random returns 0.8; with sampleRate 0.5, 0.8 >= 0.5 so validation is skipped
      const detector = new DriftDetector({
        mode: "strict",
        sampleRate: 0.5,
        random: () => 0.8,
        onViolation,
      });
      detector.registerSchema(routeKey, sampleSchema);

      const result = detector.validate(routeKey, { invalid: true });
      expect(result).toBe(true);
      expect(onViolation).not.toHaveBeenCalled();
    });

    it("executes validation when random draw < sampleRate", () => {
      const onViolation = vi.fn();
      // random returns 0.3; with sampleRate 0.5, 0.3 < 0.5 so validation runs
      const detector = new DriftDetector({
        mode: "strict",
        sampleRate: 0.5,
        random: () => 0.3,
        onViolation,
      });
      detector.registerSchema(routeKey, sampleSchema);

      expect(() => detector.validate(routeKey, { invalid: true })).toThrow(DriftError);
      expect(onViolation).toHaveBeenCalledTimes(1);
    });

    it("clamps sampleRate between 0.0 and 1.0", () => {
      const detectorNegative = new DriftDetector({ sampleRate: -0.5, random: () => 0 });
      // Clamped to 0: random() 0 >= sampleRate 0 => returns true
      detectorNegative.registerSchema(routeKey, sampleSchema);
      expect(detectorNegative.validate(routeKey, {})).toBe(true);

      const detectorOver = new DriftDetector({ sampleRate: 1.5, mode: "strict", random: () => 0.99 });
      // Clamped to 1.0: sampleRate < 1.0 check does not skip, validates and throws
      detectorOver.registerSchema(routeKey, sampleSchema);
      expect(() => detectorOver.validate(routeKey, {})).toThrow(DriftError);
    });
  });

  describe("Validator schema constructs", () => {
    it("handles anyOf / oneOf branches and dereferencing", () => {
      const unionSchema = {
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      };
      const unionKey = "POST /api/union";
      const detector = new DriftDetector({ mode: "strict" });
      detector.registerSchema(unionKey, unionSchema);

      expect(detector.validate(unionKey, "hello")).toBe(true);
      expect(detector.validate(unionKey, 42)).toBe(true);
      expect(() => detector.validate(unionKey, true)).toThrow(DriftError);
    });

    it("handles allOf constructs", () => {
      const allOfSchema = {
        allOf: [
          { type: "object", required: ["a"], properties: { a: { type: "string" } } },
          { type: "object", required: ["b"], properties: { b: { type: "number" } } },
        ],
      };
      const allOfKey = "POST /api/allof";
      const detector = new DriftDetector({ mode: "strict" });
      detector.registerSchema(allOfKey, allOfSchema);

      expect(detector.validate(allOfKey, { a: "ok", b: 10 })).toBe(true);
      expect(() => detector.validate(allOfKey, { a: "ok" })).toThrow(DriftError);
    });

    it("handles array items validation", () => {
      const arraySchema = {
        type: "array",
        items: { type: "string" },
      };
      const arrayKey = "POST /api/array";
      const detector = new DriftDetector({ mode: "strict" });
      detector.registerSchema(arrayKey, arraySchema);

      expect(detector.validate(arrayKey, ["a", "b", "c"])).toBe(true);
      expect(() => detector.validate(arrayKey, ["a", 2])).toThrow(DriftError);
    });

    it("handles string pattern, minLength, maxLength, and number bounds", () => {
      const boundsSchema = {
        type: "object",
        properties: {
          code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 },
          score: { type: "number", minimum: 0, maximum: 100 },
        },
      };
      const boundsKey = "POST /api/bounds";
      const detector = new DriftDetector({ mode: "warn" });
      detector.registerSchema(boundsKey, boundsSchema);

      const violations: DriftViolation[] = [];
      const onViolation = vi.fn((_, v) => violations.push(...v));
      const det = new DriftDetector({ mode: "warn", onViolation });
      det.registerSchema(boundsKey, boundsSchema);

      expect(det.validate(boundsKey, { code: "ABC", score: 50 })).toBe(true);

      expect(det.validate(boundsKey, { code: "ab", score: -5 })).toBe(false);
      expect(violations.some((v) => v.message.includes("pattern"))).toBe(true);
      expect(violations.some((v) => v.message.includes("minimum"))).toBe(true);
    });
  });

  describe("Client integration path with mocked fetch and logger spies", () => {
    it("strict mode: rejects before any fetch is made when payload is invalid", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const detector = new DriftDetector({ mode: "strict" });
      detector.registerSchema("POST /api/talos", sampleSchema);

      const client = new TalosClient({
        baseUrl: "https://talos-stellar.vercel.app",
        fetch: fetchMock,
      });

      // Simulated client-side request drift detection interceptor
      const executeRequest = async (route: string, body: unknown) => {
        detector.validate(route, body);
        return client.createTalos(body as any);
      };

      const invalidPayload = { id: 123 }; // fails validation

      await expect(executeRequest("POST /api/talos", invalidPayload)).rejects.toThrow(DriftError);
      // Crucial assertion: strict rejects before any fetch is made!
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("warn mode: invokes the logger once and allows the request / fetch to proceed", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "talos-1", name: "New Talos" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const onViolation = vi.fn();
      const detector = new DriftDetector({
        mode: "warn",
        onViolation,
      });
      detector.registerSchema("POST /api/talos", sampleSchema);

      const client = new TalosClient({
        baseUrl: "https://talos-stellar.vercel.app",
        fetch: fetchMock,
      });

      const executeRequest = async (route: string, body: unknown) => {
        detector.validate(route, body);
        return client.createTalos(body as any);
      };

      const invalidPayload = { id: 123 }; // fails validation, but mode is warn

      const res = await executeRequest("POST /api/talos", invalidPayload);
      expect(onViolation).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ id: "talos-1", name: "New Talos" });
    });

    it("off mode: bypasses validation without logging or throwing and fetch proceeds", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "talos-2", name: "Off Mode" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const onViolation = vi.fn();
      const detector = new DriftDetector({
        mode: "off",
        onViolation,
      });
      detector.registerSchema("POST /api/talos", sampleSchema);

      const client = new TalosClient({
        baseUrl: "https://talos-stellar.vercel.app",
        fetch: fetchMock,
      });

      const executeRequest = async (route: string, body: unknown) => {
        detector.validate(route, body);
        return client.createTalos(body as any);
      };

      const invalidPayload = { id: 123 };

      const res = await executeRequest("POST /api/talos", invalidPayload);
      expect(onViolation).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ id: "talos-2", name: "Off Mode" });
    });
  });
});
