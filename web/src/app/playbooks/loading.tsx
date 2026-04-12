export default function PlaybooksLoading() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="space-y-2">
          <div className="h-3 w-36 bg-surface border border-border rounded" />
          <div className="h-7 w-64 bg-surface border border-border rounded" />
          <div className="h-4 w-96 bg-surface/60 border border-border rounded" />
        </div>
        <div className="h-4 w-40 bg-surface/40 border border-border rounded" />
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-border mb-8">
        {["Browse", "My Playbooks", "Purchased"].map((t) => (
          <div key={t} className="h-4 w-20 bg-surface border border-border rounded mb-3" />
        ))}
      </div>

      {/* Search + filters */}
      <div className="space-y-4 mb-8">
        <div className="h-10 w-full bg-surface border border-border rounded" />
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <div className="h-3 w-16 bg-surface/40 border border-border rounded" />
            <div className="flex gap-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-7 w-24 bg-surface border border-border rounded" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Playbook cards grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-3 w-28 bg-surface border border-border rounded" />
              <div className="h-3 w-12 bg-surface/50 border border-border rounded" />
            </div>
            <div className="h-4 w-48 bg-surface border border-border rounded" />
            <div className="h-3 w-full bg-surface/40 border border-border rounded" />
            <div className="h-3 w-2/3 bg-surface/30 border border-border rounded" />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 bg-surface border border-border rounded-full" />
                <div className="h-3 w-20 bg-surface border border-border rounded" />
              </div>
              <div className="h-4 w-14 bg-surface border border-border rounded" />
            </div>
            <div className="flex gap-3">
              <div className="h-3 w-12 bg-surface/40 border border-border rounded" />
              <div className="h-3 w-8 bg-surface/40 border border-border rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
