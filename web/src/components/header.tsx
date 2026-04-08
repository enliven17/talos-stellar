"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStellarWallet } from "./providers";

const NAV_ITEMS = [
  { href: "/agents", label: "Agents", requiresWallet: false },
  { href: "/activity", label: "Activity", requiresWallet: false },
  { href: "/playbooks", label: "Playbooks", requiresWallet: false },
  { href: "/leaderboard", label: "Leaderboard", requiresWallet: false },
  { href: "/docs", label: "Docs", requiresWallet: false, highlight: true },
];

export function Header() {
  const pathname = usePathname();
  const { isConnected, publicKey, connect, disconnect } = useStellarWallet();

  const truncatedAddress = publicKey
    ? `${publicKey.slice(0, 6)}...${publicKey.slice(-4)}`
    : null;

  return (
    <header className="border-b border-border px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-nav-accent tracking-wider text-lg font-bold">
            TALOS
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm transition-colors flex items-center gap-1.5 ${
                  item.highlight
                    ? pathname === item.href
                      ? "text-accent font-bold"
                      : "text-accent/80 hover:text-accent font-medium"
                    : pathname === item.href
                      ? "text-nav-accent"
                      : "text-muted hover:text-nav-foreground"
                }`}
              >
                {item.highlight && <span className="text-accent/60">&lt;/&gt;</span>}
                {item.label}
                {item.requiresWallet && !isConnected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-500/70" title="Wallet required" />
                )}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {isConnected && (
            <Link
              href="/dashboard"
              className={`hidden md:inline-flex text-sm transition-colors items-center gap-1.5 ${
                pathname === "/dashboard"
                  ? "text-nav-accent"
                  : "text-muted hover:text-nav-foreground"
              }`}
            >
              Dashboard
            </Link>
          )}
          <Link
            href="/launch"
            className={`hidden md:inline-flex px-4 py-2 text-sm font-medium transition-colors ${
              pathname === "/launch"
                ? "bg-accent text-background"
                : "bg-accent/90 text-background hover:bg-accent"
            }`}
          >
            Launchpad
          </Link>
          {isConnected ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-nav-foreground font-mono bg-surface border border-border px-3 py-1.5">
                {truncatedAddress}
              </span>
              <button
                onClick={disconnect}
                className="text-xs text-muted hover:text-nav-foreground transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              className="border border-border px-4 py-2 text-sm text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
