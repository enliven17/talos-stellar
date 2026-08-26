export default function Loading() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-pulse">
      <div className="mb-10 space-y-2">
        <div className="h-5 w-48 bg-surface border border-border rounded" />
        <div className="h-4 w-96 bg-border/60 rounded" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border p-5 space-y-2">
            <div className="h-3 w-24 bg-border/70 rounded" />
            <div className="h-7 w-20 bg-border rounded" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-4">
            <div className="h-4 w-32 bg-border rounded" />
            <div className="bg-surface border border-border divide-y divide-border">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="p-4 flex items-center justify-between">
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-40 bg-border rounded" />
                    <div className="h-3 w-24 bg-border/60 rounded" />
                  </div>
                  <div className="h-8 w-16 bg-border rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
