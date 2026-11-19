export default function ProposalDetailLoading() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-pulse" aria-busy="true">
      <span className="sr-only" role="status">Loading proposal</span>
      <div className="h-4 w-40 bg-surface border border-border rounded mb-8" />
      <div className="space-y-3 mb-10">
        <div className="h-7 w-80 bg-surface border border-border rounded" />
        <div className="h-4 w-full bg-border/50 rounded" />
        <div className="h-4 w-2/3 bg-border/50 rounded" />
      </div>
      <div className="space-y-4">
        <div className="h-32 bg-surface border border-border rounded-lg" />
        <div className="h-24 bg-surface border border-border rounded-lg" />
        <div className="h-40 bg-surface border border-border rounded-lg" />
      </div>
    </div>
  );
}
