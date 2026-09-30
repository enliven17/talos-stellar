"use client";

/**
 * AgentAvailabilityBadge
 *
 * Displays an agent's online / offline state with a relative "last seen"
 * timestamp.  The component is intentionally self-contained and renders
 * entirely client-side so it can be dropped into any Server Component page
 * without hydration mismatches.
 *
 * Props:
 *   agentOnline  — true = online, false = offline
 *   agentLastSeen — ISO-8601 string (or null if never seen)
 *   status        — lifecycle status: "Active" | "Paused" | "Retired"
 *   showLastSeen  — whether to render the relative timestamp (default true)
 *   size          — "sm" | "md" | "lg" (default "md")
 */

interface AgentAvailabilityBadgeProps {
  agentOnline: boolean;
  agentLastSeen: string | null;
  status?: string;
  showLastSeen?: boolean;
  size?: "sm" | "md" | "lg";
}

/** Convert an ISO-8601 timestamp to a human-readable relative string. */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

const SIZE_MAP = {
  sm: {
    dot: "w-1.5 h-1.5",
    label: "text-[10px]",
    lastSeen: "text-[10px]",
    gap: "gap-1",
  },
  md: {
    dot: "w-2 h-2",
    label: "text-xs",
    lastSeen: "text-xs",
    gap: "gap-1.5",
  },
  lg: {
    dot: "w-2.5 h-2.5",
    label: "text-sm",
    lastSeen: "text-sm",
    gap: "gap-2",
  },
};

export function AgentAvailabilityBadge({
  agentOnline,
  agentLastSeen,
  status = "Active",
  showLastSeen = true,
  size = "md",
}: AgentAvailabilityBadgeProps) {
  const sz = SIZE_MAP[size];
  const isRetired = status === "Retired";
  const isPaused = status === "Paused";

  // Compute dot colour:
  //  - online + active  → accent green
  //  - paused           → yellow/amber
  //  - retired          → red/muted
  //  - offline          → grey
  const dotColor = isRetired
    ? "bg-red-500/60"
    : isPaused
      ? "bg-yellow-400"
      : agentOnline
        ? "bg-accent"
        : "bg-muted/40";

  const labelText = isRetired
    ? "RETIRED"
    : isPaused
      ? "PAUSED"
      : agentOnline
        ? "ONLINE"
        : "OFFLINE";

  const labelColor = isRetired
    ? "text-red-400"
    : isPaused
      ? "text-yellow-400"
      : agentOnline
        ? "text-accent font-bold"
        : "text-muted";

  return (
    <span
      className={`inline-flex items-center ${sz.gap}`}
      data-testid="agent-availability-badge"
      aria-label={`Agent is ${labelText.toLowerCase()}`}
    >
      {/* Pulsing dot when online */}
      <span className="relative inline-flex">
        <span className={`${sz.dot} rounded-full ${dotColor}`} />
        {agentOnline && !isRetired && !isPaused && (
          <span
            className={`animate-ping absolute inline-flex ${sz.dot} rounded-full bg-accent opacity-40`}
          />
        )}
      </span>

      {/* Label */}
      <span className={`${sz.label} ${labelColor} leading-none`}>
        {labelText}
      </span>

      {/* Last-seen */}
      {showLastSeen && !agentOnline && agentLastSeen && (
        <span
          className={`${sz.lastSeen} text-muted leading-none`}
          title={new Date(agentLastSeen).toLocaleString()}
        >
          · {formatRelativeTime(agentLastSeen)}
        </span>
      )}

      {showLastSeen && !agentOnline && !agentLastSeen && (
        <span className={`${sz.lastSeen} text-muted leading-none`}>
          · never seen
        </span>
      )}
    </span>
  );
}
