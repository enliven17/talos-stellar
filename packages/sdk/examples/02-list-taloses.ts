/**
 * Example: List Taloses with cursor-based pagination
 *
 * Demonstrates: listTaloses, CursorPage, Talos
 */
import { TalosClient } from "../src/index.js";
import type { CursorPage, Talos } from "../src/index.js";

const client = new TalosClient({ baseUrl: "https://talos-stellar.vercel.app" });

async function main(): Promise<void> {
  let cursor: string | undefined;

  do {
    const page: CursorPage<Talos> = await client.listTaloses({ limit: 10, cursor });
    for (const talos of page.data) {
      console.log(`[${talos.status}] ${talos.name} (${talos.category}) — ${talos.id}`);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

main().catch(console.error);
