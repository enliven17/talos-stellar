import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/docs/openapi.json/route";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("OpenAPI snapshot", () => {
  it("matches the JSON served by /api/docs/openapi.json", async () => {
    const response = GET();
    const spec = await response.json();
    const actual = `${JSON.stringify(spec, null, 2)}\n`;
    const expected = await readFile(
      path.resolve(__dirname, "fixtures/openapi.snapshot.json"),
      "utf8",
    );

    expect(actual).toEqual(expected);
  });
});
