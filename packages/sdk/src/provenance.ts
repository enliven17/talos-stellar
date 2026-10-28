/**
 * Provenance metadata for auto-generated SDK types.
 *
 * These constants describe the origin of the generated types in
 * `generated-types.ts` so contributors and operators can audit exactly
 * which OpenAPI snapshot and tool version produced the current types.
 *
 * The metadata is committed alongside the generated file and updated
 * whenever types are regenerated (see `pnpm generate:types`).
 */

/** The generation tool used to produce `generated-types.ts`. */
export const GENERATED_TYPES_TOOL = "openapi-typescript" as const;

/** The minimum tool version used during generation. */
export const GENERATED_TYPES_TOOL_VERSION = "^7.4.3" as const;

/** Path (relative to repo root) of the OpenAPI source snapshot. */
export const GENERATED_TYPES_SOURCE =
  "web/tests/fixtures/openapi.snapshot.json" as const;

/** NPM package name this file belongs to. */
export const GENERATED_TYPES_PACKAGE = "@talos-protocol/sdk" as const;

/**
 * Structured provenance record combining all fields above.
 * Import this for programmatic checks or logging.
 */
export interface GeneratedTypesProvenance {
  tool: string;
  toolVersion: string;
  source: string;
  pkg: string;
}

export const GENERATED_TYPES_PROVENANCE: GeneratedTypesProvenance = {
  tool: GENERATED_TYPES_TOOL,
  toolVersion: GENERATED_TYPES_TOOL_VERSION,
  source: GENERATED_TYPES_SOURCE,
  pkg: GENERATED_TYPES_PACKAGE,
};
