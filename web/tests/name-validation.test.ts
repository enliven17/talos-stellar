/**
 * Name validation tests using shared vectors.
 *
 * These tests ensure that the web's validation logic matches the contract's
 * validation logic by using the same test vectors.
 */

import { describe, it, expect } from "vitest";
import {
  validateName,
  canonicalizeName,
  validateAndCanonicalizeName,
} from "../src/lib/name-validation";
import nameValidationVectors from "./fixtures/name-validation-vectors.json";

describe("name-validation", () => {
  describe("validateName", () => {
    it("accepts all valid names from shared vectors", () => {
      const validNames = nameValidationVectors.valid_names;
      for (const entry of validNames) {
        expect(validateName(entry.name)).toBe(true);
      }
    });

    it("rejects all invalid names from shared vectors", () => {
      const invalidNames = nameValidationVectors.invalid_names;
      for (const entry of invalidNames) {
        expect(validateName(entry.name)).toBe(false);
      }
    });

    it("rejects names that are too short", () => {
      expect(validateName("ab")).toBe(false);
      expect(validateName("a")).toBe(false);
      expect(validateName("")).toBe(false);
    });

    it("rejects names that are too long", () => {
      expect(validateName("a".repeat(33))).toBe(false);
    });

    it("rejects names with uppercase letters", () => {
      expect(validateName("Alpha")).toBe(false);
      expect(validateName("ALPHA")).toBe(false);
    });

    it("rejects names with consecutive hyphens", () => {
      expect(validateName("bad--name")).toBe(false);
      expect(validateName("test---name")).toBe(false);
    });

    it("rejects names with leading hyphens", () => {
      expect(validateName("-bad")).toBe(false);
    });

    it("rejects names with trailing hyphens", () => {
      expect(validateName("bad-")).toBe(false);
    });

    it("rejects names with invalid characters", () => {
      expect(validateName("test name")).toBe(false);
      expect(validateName("test_name")).toBe(false);
      expect(validateName("test.name")).toBe(false);
      expect(validateName("test@name")).toBe(false);
    });
  });

  describe("canonicalizeName", () => {
    it("canonicalizes all vectors from shared fixture", () => {
      const vectors = nameValidationVectors.canonicalization_vectors;
      for (const entry of vectors) {
        const result = canonicalizeName(entry.input);
        expect(result).toBe(entry.canonicalized);
      }
    });

    it("trims leading whitespace", () => {
      expect(canonicalizeName("  vega")).toBe("vega");
      expect(canonicalizeName("\tvega")).toBe("vega");
      expect(canonicalizeName("\nvega")).toBe("vega");
    });

    it("trims trailing whitespace", () => {
      expect(canonicalizeName("vega  ")).toBe("vega");
      expect(canonicalizeName("vega\t")).toBe("vega");
      expect(canonicalizeName("vega\n")).toBe("vega");
    });

    it("lowercases uppercase letters", () => {
      expect(canonicalizeName("Vega")).toBe("vega");
      expect(canonicalizeName("VEGA")).toBe("vega");
      expect(canonicalizeName("Alpha-1")).toBe("alpha-1");
    });

    it("throws on empty string after trimming", () => {
      expect(() => canonicalizeName("")).toThrow("Name cannot be empty after canonicalization");
      expect(() => canonicalizeName("   ")).toThrow("Name cannot be empty after canonicalization");
      expect(() => canonicalizeName("\t\n")).toThrow("Name cannot be empty after canonicalization");
    });

    it("throws on name exceeding max length after canonicalization", () => {
      expect(() => canonicalizeName("A".repeat(33))).toThrow("Name exceeds maximum byte length after canonicalization");
    });
  });

  describe("validateAndCanonicalizeName", () => {
    it("validates and canonicalizes valid names", () => {
      expect(validateAndCanonicalizeName("Vega")).toBe("vega");
      expect(validateAndCanonicalizeName(" ALPHA-1 ")).toBe("alpha-1");
      expect(validateAndCanonicalizeName("marketbot")).toBe("marketbot");
    });

    it("throws on invalid names", () => {
      expect(() => validateAndCanonicalizeName("ab")).toThrow();
      expect(() => validateAndCanonicalizeName("bad--name")).toThrow();
      expect(() => validateAndCanonicalizeName("-bad")).toThrow();
      expect(() => validateAndCanonicalizeName("bad-")).toThrow();
    });

    it("throws on empty names", () => {
      expect(() => validateAndCanonicalizeName("")).toThrow();
      expect(() => validateAndCanonicalizeName("   ")).toThrow();
    });
  });
});
