import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsPlaybooks, tlsPlaybookPurchases, tlsActivities } from "@/db/schema";
import { and, eq } from "drizzle-orm";

// PATCH /api/playbooks/:id/apply — Mark a purchased playbook as applied
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await request.json();
    const { buyerPublicKey } = body;

    if (!buyerPublicKey) {
      return Response.json(
        { error: "buyerPublicKey is required" },
        { status: 400 }
      );
    }

    // Verify playbook exists
    const playbook = await db
      .select()
      .from(tlsPlaybooks)
      .where(eq(tlsPlaybooks.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!playbook) {
      return Response.json({ error: "Playbook not found" }, { status: 404 });
    }

    // Verify purchase exists
    const purchase = await db
      .select()
      .from(tlsPlaybookPurchases)
      .where(
        and(
          eq(tlsPlaybookPurchases.playbookId, id),
          eq(tlsPlaybookPurchases.buyerPublicKey, buyerPublicKey)
        )
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!purchase) {
      return Response.json(
        { error: "No purchase found for this playbook and wallet" },
        { status: 404 }
      );
    }

    if (purchase.appliedAt) {
      return Response.json(
        { error: "Playbook already applied", appliedAt: purchase.appliedAt },
        { status: 409 }
      );
    }

    // Mark as applied + create activity entries from playbook content
    const [updated] = await db
      .update(tlsPlaybookPurchases)
      .set({ appliedAt: new Date() })
      .where(eq(tlsPlaybookPurchases.id, purchase.id))
      .returning();

    // Inject playbook tactics as pending activities for the agent to execute
    const content = playbook.content as Record<string, unknown> | null;
    const activitiesCreated: string[] = [];

    if (content) {
      const tactics = (content.tactics as string[]) ?? [];
      const templates = (content.templates as string[]) ?? [];
      const schedule = content.schedule as Record<string, unknown> | null;

      const activityRows = [];

      for (const tactic of tactics.slice(0, 5)) {
        activityRows.push({
          talosId: playbook.talosId,
          type: "post",
          content: `[Playbook: ${playbook.title}] ${tactic}`,
          channel: playbook.channel,
          status: "pending",
        });
      }

      for (const template of templates.slice(0, 3)) {
        activityRows.push({
          talosId: playbook.talosId,
          type: "post",
          content: `[Playbook template] ${template}`,
          channel: playbook.channel,
          status: "pending",
        });
      }

      if (schedule && typeof schedule.summary === "string") {
        activityRows.push({
          talosId: playbook.talosId,
          type: "research",
          content: `[Playbook schedule applied] ${schedule.summary}`,
          channel: "internal",
          status: "pending",
        });
      }

      if (activityRows.length > 0) {
        const inserted = await db.insert(tlsActivities).values(activityRows).returning({ id: tlsActivities.id });
        activitiesCreated.push(...inserted.map(r => r.id));
      }
    }

    return Response.json({
      ...updated,
      content: playbook.content,
      activitiesCreated,
      message: `Playbook "${playbook.title}" applied. ${activitiesCreated.length} tasks queued for the agent.`,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
