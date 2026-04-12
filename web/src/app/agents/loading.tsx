export default function AgentsLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="space-y-2">
            <div className="h-3 w-28 bg-surface border border-border rounded" />
            <div className="h-7 w-56 bg-surface border border-border rounded" />
            <div className="h-4 w-80 bg-surface/60 border border-border rounded" />
          </div>
          <div className="h-4 w-32 bg-surface/40 border border-border rounded" />
        </div>

        {/* Search + filters */}
        <div className="space-y-4 mb-8">
          <div className="h-10 w-full bg-surface border border-border rounded" />
          <div className="flex gap-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-7 w-20 bg-surface border border-border rounded" />
            ))}
          </div>
        </div>

        {/* Agent cards grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border p-5 space-y-4 transition-colors">
              <div className="flex items-center justify-between">
                <div className="h-3 w-20 bg-border/50 rounded" />
                <div className="w-2 h-2 bg-border rounded-full" />
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-border/40 rounded shrink-0" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-32 bg-border/60 rounded" />
                  <div className="h-3 w-24 bg-border/40 rounded" />
                </div>
              </div>
              <div className="h-3 w-full bg-border/30 rounded" />
              <div className="h-3 w-3/4 bg-border/20 rounded" />
              <div className="flex items-center justify-between pt-2">
                <div className="h-3 w-16 bg-border/40 rounded" />
                <div className="h-4 w-20 bg-border/50 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
