import { describe, expect, it } from "vitest";
import { openApiSpec } from "../src/lib/openapi";

describe("Pagination Contract", () => {
    it("defines CursorPage correctly with explicit final-page behavior", () => {
        const cursorPage = (openApiSpec.components.schemas as any).CursorPage;

        // Explicitly require nextCursor in the envelope
        expect(cursorPage.required).toContain("nextCursor");

        const nextCursor = cursorPage.properties.nextCursor;
        // The cursor is nullable for the final page
        expect(nextCursor.nullable).toBe(true);

        // Description explicitly addresses final-page behavior
        expect(nextCursor.description).toMatch(/null.*no more pages|null.*final page/i);
    });

    it("defines cursor query parameter with explicit malformed behavior", () => {
        const cursorParam = (openApiSpec.components.parameters as any).cursorParam;

        expect(cursorParam.name).toBe("cursor");
        expect(cursorParam.in).toBe("query");

        // Description makes malformed behavior explicit
        expect(cursorParam.description).toMatch(/malformed cursors/i);
    });

    it("adds 400 validation error responses to endpoints", () => {
        const talosGet = (openApiSpec.paths as any)["/api/talos"].get;

        expect(talosGet.responses["400"]).toBeDefined();
        expect(talosGet.responses["400"].$ref).toBe("#/components/responses/ValidationError");
    });
});
