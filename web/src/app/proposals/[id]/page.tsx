import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProposalDetail } from "@/components/proposals/proposal-detail";
import { parseProposalRoute } from "@/lib/proposal-detail";
import { loadProposalPage, sanitizeCursor } from "@/lib/proposal-detail-data";

// Votes and tallies change while a proposal is open, so never serve a cached render.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Proposal | TALOS" };

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}

export default async function ProposalDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, { cursor }] = await Promise.all([params, searchParams]);

  const route = parseProposalRoute(id);
  if (!route) notFound();

  const data = await loadProposalPage(route, sanitizeCursor(cursor));
  if (data.kind === "not-found") notFound();

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <Link
        href="/proposals"
        className="text-sm text-muted hover:text-accent transition-colors inline-block mb-8"
      >
        &larr; Back to proposals
      </Link>

      {data.kind === "notice" ? (
        <div role="status">
          <h1 className="text-xl font-bold text-foreground mb-2">{data.title}</h1>
          <p className="text-sm text-muted">{data.message}</p>
        </div>
      ) : (
        <ProposalDetail
          view={data.view}
          timeline={data.timeline}
          votes={data.votes}
          notices={data.notices}
        />
      )}
    </div>
  );
}
