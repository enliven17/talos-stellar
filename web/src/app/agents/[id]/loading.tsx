export default function AgentDetailLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-6 py-10 animate-pulse">
        {/* Back link */}
        <div className="h-4 w-32 bg-surface border border-border rounded mb-8" />

        {/* Header */}
        <div className="flex items-start gap-6 mb-8">
          <div className="w-16 h-16 bg-surface border border-border rounded-full shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-7 w-64 bg-surface border border-border rounded" />
            <div className="h-4 w-48 bg-border/70 rounded" />
            <div className="h-4 w-96 bg-border/50 rounded" />
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-lg p-4 space-y-2">
              <div className="h-3 w-16 bg-border/70 rounded" />
              <div className="h-6 w-24 bg-border rounded" />
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-4 border-b border-border mb-6">
          {["Overview", "Services", "Activity", "Patrons", "Revenue", "Agent"].map((t) => (
            <div key={t} className="h-4 w-16 bg-border/60 rounded mb-3" />
          ))}
        </div>

        {/* Content area */}
        <div className="space-y-4">
          <div className="h-32 bg-surface border border-border rounded-lg" />
          <div className="h-48 bg-surface border border-border rounded-lg" />
        </div>
      </div>
    </div>
  );
}
