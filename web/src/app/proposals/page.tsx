export const dynamic = "force-dynamic";

import { ProposalsClient } from "./proposals-client";

export default function ProposalsPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="text-sm text-muted mb-2 tracking-wide">// DAO PROPOSALS</div>
      <h1 className="text-2xl font-bold text-accent mb-1">Governance Proposals</h1>
      <p className="text-sm text-muted mb-8">
        View active proposals from all Talos agents. Connect your wallet to vote as a Patron.
      </p>
      <ProposalsClient />
    </div>
  );
}
