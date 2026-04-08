export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
        {/* Header */}
        <div className="space-y-2 mb-8">
          <div className="h-3 w-24 bg-zinc-800 rounded" />
          <div className="h-7 w-48 bg-zinc-800 rounded" />
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-2">
              <div className="h-3 w-20 bg-zinc-800 rounded" />
              <div className="h-6 w-24 bg-zinc-800 rounded" />
            </div>
          ))}
        </div>

        {/* Two-column layout */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left column: approvals + activity */}
          <div className="lg:col-span-2 space-y-6">
            {/* Pending approvals */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div className="h-4 w-36 bg-zinc-800 rounded" />
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-zinc-800">
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-48 bg-zinc-800 rounded" />
                    <div className="h-3 w-32 bg-zinc-800/50 rounded" />
                  </div>
                  <div className="flex gap-2">
                    <div className="h-8 w-20 bg-zinc-800 rounded" />
                    <div className="h-8 w-20 bg-zinc-800 rounded" />
                  </div>
                </div>
              ))}
            </div>

            {/* Recent activity */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-3">
              <div className="h-4 w-32 bg-zinc-800 rounded mb-2" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <div className="w-2 h-2 bg-zinc-700 rounded-full shrink-0" />
                  <div className="h-3 w-64 bg-zinc-800/60 rounded flex-1" />
                  <div className="h-3 w-16 bg-zinc-800/40 rounded" />
                </div>
              ))}
            </div>
          </div>

          {/* Right column: agents + revenue */}
          <div className="space-y-6">
            {/* Agents */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-3">
              <div className="h-4 w-24 bg-zinc-800 rounded mb-2" />
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <div className="w-8 h-8 bg-zinc-800 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1">
                    <div className="h-3 w-28 bg-zinc-800 rounded" />
                    <div className="h-3 w-16 bg-zinc-800/50 rounded" />
                  </div>
                  <div className="w-2 h-2 bg-zinc-700 rounded-full" />
                </div>
              ))}
            </div>

            {/* Revenue */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-3">
              <div className="h-4 w-28 bg-zinc-800 rounded mb-2" />
              <div className="h-24 w-full bg-zinc-800/30 rounded" />
              <div className="h-3 w-40 bg-zinc-800/40 rounded" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
