import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { internalError, notFound } from "@/lib/api-response";

function maskApiKey(key: string | null): string | null {
  if (!key || key.length < 12) return null;
  return `${key.slice(0, 8)}${"*".repeat(key.length - 12)}${key.slice(-4)}`;
}

// GET /api/talos/:id — TALOS detail + configuration
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const talos = await db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.id, id),
      with: {
        patrons: true,
        activities: { orderBy: (a, { desc }) => [desc(a.createdAt)], limit: 20 },
        approvals: { orderBy: (a, { desc }) => [desc(a.createdAt)], limit: 10 },
        revenues: { orderBy: (r, { desc }) => [desc(r.createdAt)], limit: 20 },
        commerceServices: true,
      },
    });

    if (!talos) {
      return notFound(request, "TALOS not found");
    }

    const { apiKey, ...safeTalos } = talos;
    return Response.json({ ...safeTalos, apiKeyMasked: maskApiKey(apiKey) });
  } catch {
    return internalError(request);
  }
}
