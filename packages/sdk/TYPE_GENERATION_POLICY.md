# Type Generation Policy

## Overview

The SDK uses `openapi-typescript` to generate TypeScript types from the OpenAPI specification. This ensures that SDK types stay in sync with the API specification.

## Generated File

- **Location**: `packages/sdk/src/generated-types.ts`
- **Source**: `web/tests/fixtures/openapi.snapshot.json` (the canonical OpenAPI spec)
- **Tool**: `openapi-typescript@^7.4.3`

## Generation Command

```bash
cd packages/sdk
pnpm generate:types
```

This command runs:
```bash
npx openapi-typescript "../web/tests/fixtures/openapi.snapshot.json" -o "src/generated-types.ts"
```

## Policy: Commit Generated Types

Generated types are **committed to the repository**. This is intentional because:

1. **Deterministic output**: The generator produces identical output on repeated runs (verified by testing)
2. **CI validation**: CI checks that generated types match the current OpenAPI spec
3. **Developer experience**: No build step required to use the SDK
4. **Drift detection**: Changes to the OpenAPI spec will cause CI to fail until types are regenerated

## When to Regenerate

Regenerate types when:
- The OpenAPI specification changes (`web/src/lib/openapi.ts`)
- API endpoints are added, modified, or removed
- Request/response schemas change

## Workflow

1. Make changes to the OpenAPI spec in `web/src/lib/openapi.ts`
2. Update the snapshot: `cd web && pnpm openapi:snapshot`
3. Regenerate SDK types: `cd packages/sdk && pnpm generate:types`
4. Commit both changes together

## CI Enforcement

The CI pipeline (`sdk-types-ci.yml`) automatically:
1. Regenerates types from the current OpenAPI snapshot
2. Compares them with the committed `generated-types.ts`
3. Fails if there's a mismatch (indicating drift)

This prevents scenarios where the OpenAPI spec changes but types are not updated.

## Hand-Written Types

The hand-written types in `src/types.ts` are preserved and used by the client. The generated types (`src/generated-types.ts`) provide:
- A complete reference for all API schemas
- Compile-time validation that the OpenAPI spec is valid TypeScript
- A fallback for future use if needed

The client ergonomics are preserved through the hand-written `TalosClient` class and its associated types.
