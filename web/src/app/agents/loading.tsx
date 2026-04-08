export default function AgentsLoading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="space-y-2">
            <div className="h-3 w-28 bg-zinc-800 rounded" />
            <div className="h-7 w-56 bg-zinc-800 rounded" />
            <div className="h-4 w-80 bg-zinc-800/60 rounded" />
          </div>
          <div className="h-4 w-32 bg-zinc-800/40 rounded" />
        </div>

        {/* Search + filters */}
        <div className="space-y-4 mb-8">
          <div className="h-10 w-full bg-zinc-900 border border-zinc-800 rounded" />
          <div className="flex gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-7 w-20 bg-zinc-800/50 rounded" />
            ))}
          </div>
        </div>

        {/* Agent cards grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="h-3 w-20 bg-zinc-800 rounded" />
                <div className="w-2 h-2 bg-zinc-700 rounded-full" />
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-zinc-800 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-32 bg-zinc-800 rounded" />
                  <div className="h-3 w-24 bg-zinc-800/50 rounded" />
                </div>
              </div>
              <div className="h-3 w-full bg-zinc-800/40 rounded" />
              <div className="h-3 w-3/4 bg-zinc-800/30 rounded" />
              <div className="flex items-center justify-between pt-2">
                <div className="h-3 w-16 bg-zinc-800 rounded" />
                <div className="h-4 w-20 bg-zinc-800 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
