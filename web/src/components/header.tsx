"use client";

import { useState } from "react";
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
  const [menuOpen, setMenuOpen] = useState(false);

  const truncatedAddress = publicKey
    ? `${publicKey.slice(0, 6)}...${publicKey.slice(-4)}`
    : null;

  return (
    <header className="border-b border-border bg-background relative z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
        {/* Left: logo + desktop nav */}
        <div className="flex items-center gap-6 lg:gap-8 min-w-0">
          <Link
            href="/"
            className="text-nav-accent text-3xl sm:text-4xl font-ruthie shrink-0"
            onClick={() => setMenuOpen(false)}
          >
            Talos
          </Link>
          <nav className="hidden md:flex items-center gap-5 lg:gap-6">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm transition-colors flex items-center gap-1.5 whitespace-nowrap ${
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

        {/* Right: desktop actions + mobile hamburger */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Desktop only */}
          {isConnected && (
            <Link
              href="/dashboard"
              className={`hidden md:inline-flex text-sm transition-colors items-center gap-1.5 ${
                pathname === "/dashboard" ? "text-nav-accent" : "text-muted hover:text-nav-foreground"
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
            <div className="hidden md:flex items-center gap-3">
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
              className="hidden md:inline-flex border border-border px-4 py-2 text-sm text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Connect Wallet
            </button>
          )}

          {/* Mobile: wallet status pill */}
          {isConnected && (
            <span className="md:hidden text-xs font-mono text-nav-foreground bg-surface border border-border px-2 py-1">
              {truncatedAddress}
            </span>
          )}

          {/* Hamburger */}
          <button
            className="md:hidden flex flex-col justify-center items-center w-8 h-8 gap-1.5 text-foreground"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
          >
            <span
              className={`block h-px w-5 bg-current transition-transform origin-center ${menuOpen ? "translate-y-[7px] rotate-45" : ""}`}
            />
            <span
              className={`block h-px w-5 bg-current transition-opacity ${menuOpen ? "opacity-0" : ""}`}
            />
            <span
              className={`block h-px w-5 bg-current transition-transform origin-center ${menuOpen ? "-translate-y-[7px] -rotate-45" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="md:hidden border-t border-border bg-background absolute top-full left-0 right-0 z-50 shadow-lg">
          <nav className="flex flex-col px-4 py-3 gap-0.5">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-2 px-2 py-3 text-sm border-b border-border/50 last:border-0 ${
                  item.highlight
                    ? pathname === item.href
                      ? "text-accent font-bold"
                      : "text-accent/80 font-medium"
                    : pathname === item.href
                      ? "text-nav-accent"
                      : "text-muted"
                }`}
              >
                {item.highlight && <span className="text-accent/60 text-xs">&lt;/&gt;</span>}
                {item.label}
              </Link>
            ))}
            {isConnected && (
              <Link
                href="/dashboard"
                onClick={() => setMenuOpen(false)}
                className={`flex items-center px-2 py-3 text-sm border-b border-border/50 ${
                  pathname === "/dashboard" ? "text-nav-accent" : "text-muted"
                }`}
              >
                Dashboard
              </Link>
            )}
            <Link
              href="/launch"
              onClick={() => setMenuOpen(false)}
              className="flex items-center px-2 py-3 text-sm text-accent font-medium border-b border-border/50"
            >
              Launchpad →
            </Link>
            <div className="pt-3 pb-2">
              {isConnected ? (
                <button
                  onClick={() => { disconnect(); setMenuOpen(false); }}
                  className="text-xs text-muted hover:text-foreground transition-colors"
                >
                  Disconnect wallet
                </button>
              ) : (
                <button
                  onClick={() => { connect(); setMenuOpen(false); }}
                  className="w-full border border-border py-2.5 text-sm text-foreground hover:bg-surface transition-colors"
                >
                  Connect Wallet
                </button>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
