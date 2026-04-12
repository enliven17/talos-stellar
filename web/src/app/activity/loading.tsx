export default function ActivityLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-6 py-10 animate-pulse">
        {/* Header */}
        <div className="h-7 w-48 bg-surface border border-border rounded mb-2" />
        <div className="h-4 w-72 bg-surface/60 border border-border rounded mb-8" />

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border p-4 space-y-2">
              <div className="h-3 w-20 bg-border/50 rounded" />
              <div className="h-6 w-16 bg-border/40 rounded" />
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {["All", "Service", "Playbook"].map((t) => (
            <div key={t} className="h-8 w-20 bg-surface border border-border rounded-full" />
          ))}
        </div>

        {/* Transaction rows */}
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="bg-surface border border-border p-4 flex items-center gap-4"
            >
              <div className="w-2 h-2 bg-border rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-64 bg-border/60 rounded" />
                <div className="h-3 w-40 bg-border/40 rounded" />
              </div>
              <div className="h-4 w-20 bg-border/50 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
