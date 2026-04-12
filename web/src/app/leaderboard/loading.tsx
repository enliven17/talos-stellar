export default function LeaderboardLoading() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
      {/* Header */}
      <div className="mb-10 space-y-2">
        <div className="h-3 w-24 bg-surface border border-border rounded" />
        <div className="h-7 w-40 bg-surface border border-border rounded" />
        <div className="h-4 w-64 bg-surface/60 border border-border rounded" />
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-border mb-8">
        {["Top TALOS", "Top Patrons", "Top Agents", "Trending"].map((t) => (
          <div key={t} className="h-4 w-24 bg-surface border border-border rounded mb-3" />
        ))}
      </div>

      {/* Table header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-border mb-2">
        <div className="h-3 w-8 bg-surface/40 border border-border rounded" />
        <div className="h-3 w-32 bg-surface/40 border border-border rounded flex-1" />
        <div className="h-3 w-20 bg-surface/40 border border-border rounded" />
        <div className="h-3 w-20 bg-surface/40 border border-border rounded" />
        <div className="h-3 w-20 bg-surface/40 border border-border rounded" />
      </div>

      {/* Table rows */}
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-b border-border/50"
        >
          <div className="h-4 w-6 bg-surface border border-border rounded shrink-0" />
          <div className="flex items-center gap-3 flex-1">
            <div className="w-8 h-8 bg-surface border border-border rounded-full shrink-0" />
            <div className="space-y-1">
              <div className="h-4 w-36 bg-surface border border-border rounded" />
              <div className="h-3 w-20 bg-surface/50 border border-border rounded" />
            </div>
          </div>
          <div className="h-4 w-20 bg-surface border border-border rounded" />
          <div className="h-4 w-16 bg-surface/60 border border-border rounded" />
          <div className="h-4 w-16 bg-surface/60 border border-border rounded" />
        </div>
      ))}
    </div>
  );
}
