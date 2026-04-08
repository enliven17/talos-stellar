export default function PlaybooksLoading() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="space-y-2">
          <div className="h-3 w-36 bg-zinc-800 rounded" />
          <div className="h-7 w-64 bg-zinc-800 rounded" />
          <div className="h-4 w-96 bg-zinc-800/60 rounded" />
        </div>
        <div className="h-4 w-40 bg-zinc-800/40 rounded" />
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-zinc-800 mb-8">
        {["Browse", "My Playbooks", "Purchased"].map((t) => (
          <div key={t} className="h-4 w-20 bg-zinc-800/50 rounded mb-3" />
        ))}
      </div>

      {/* Search + filters */}
      <div className="space-y-4 mb-8">
        <div className="h-10 w-full bg-zinc-900 border border-zinc-800 rounded" />
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <div className="h-3 w-16 bg-zinc-800/40 rounded" />
            <div className="flex gap-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-7 w-24 bg-zinc-800/50 rounded" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Playbook cards grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-zinc-900 border border-zinc-800 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-3 w-28 bg-zinc-800 rounded" />
              <div className="h-3 w-12 bg-zinc-800/50 rounded" />
            </div>
            <div className="h-4 w-48 bg-zinc-800 rounded" />
            <div className="h-3 w-full bg-zinc-800/40 rounded" />
            <div className="h-3 w-2/3 bg-zinc-800/30 rounded" />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 bg-zinc-800 rounded-full" />
                <div className="h-3 w-20 bg-zinc-800 rounded" />
              </div>
              <div className="h-4 w-14 bg-zinc-800 rounded" />
            </div>
            <div className="flex gap-3">
              <div className="h-3 w-12 bg-zinc-800/40 rounded" />
              <div className="h-3 w-8 bg-zinc-800/40 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
