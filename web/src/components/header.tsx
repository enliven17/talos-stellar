"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStellarWallet } from "./providers";
import { ThemeToggle } from "./theme-toggle";
import { LocaleSwitch } from "./locale-switch";
import { useTranslation, type MessageKey } from "@/lib/i18n";

interface NavItemConfig {
  href: string;
  labelKey: MessageKey;
  requiresWallet: boolean;
  highlight?: boolean;
}

const NAV_ITEMS: NavItemConfig[] = [
  { href: "/agents", labelKey: "header.nav.agents", requiresWallet: false },
  { href: "/marketplace", labelKey: "header.nav.marketplace", requiresWallet: false },
  { href: "/activity", labelKey: "header.nav.activity", requiresWallet: false },
  { href: "/proposals", labelKey: "header.nav.proposals", requiresWallet: false },
  { href: "/playbooks", labelKey: "header.nav.playbooks", requiresWallet: false },
  { href: "/webhooks", labelKey: "header.nav.webhooks", requiresWallet: false },
  { href: "/leaderboard", labelKey: "header.nav.leaderboard", requiresWallet: false },
  { href: "/docs", labelKey: "header.nav.docs", requiresWallet: false, highlight: true },
];

export function Header() {
  const pathname = usePathname();
  const { isConnected, publicKey, connect, disconnect } = useStellarWallet();
  const { t } = useTranslation();
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
            data-testid="nav-link-home"
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
                data-testid={`nav-link-${item.href.slice(1)}`}
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
                {t(item.labelKey)}
                {item.requiresWallet && !isConnected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-500/70" title={t("header.walletRequired")} />
                )}
              </Link>
            ))}
          </nav>
        </div>

        {/* Right: desktop actions + mobile hamburger */}
        <div className="flex items-center gap-2 sm:gap-3">
          <LocaleSwitch />
          <ThemeToggle />
          {/* Desktop only */}
          {isConnected && (
            <Link
              href="/dashboard"
              data-testid="nav-link-dashboard"
              className={`hidden md:inline-flex text-sm transition-colors items-center gap-1.5 ${
                pathname === "/dashboard" ? "text-nav-accent" : "text-muted hover:text-nav-foreground"
              }`}
            >
              {t("header.dashboard")}
            </Link>
          )}
          <Link
            href="/launch"
            data-testid="nav-link-launch"
            className={`hidden md:inline-flex px-4 py-2 text-sm font-medium transition-colors ${
              pathname === "/launch"
                ? "bg-accent text-background"
                : "bg-accent/90 text-background hover:bg-accent"
            }`}
          >
            {t("header.launchpad")}
          </Link>
          {isConnected ? (
            <div className="hidden md:flex items-center gap-3">
              <span
                data-testid="connected-wallet-address"
                className="text-xs text-nav-foreground font-mono bg-surface border border-border px-3 py-1.5"
              >
                {truncatedAddress}
              </span>
              {publicKey && (
                <CopyButton
                  value={publicKey}
                  label="Copy wallet address"
                  confirmText="Copied!"
                  className="px-1.5 py-1"
                />
              )}
              <button
                onClick={disconnect}
                data-testid="disconnect-wallet-button"
                className="text-xs text-muted hover:text-nav-foreground transition-colors"
              >
                {t("header.disconnect")}
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              data-testid="connect-wallet-button"
              className="hidden md:inline-flex border border-border px-4 py-2 text-sm text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
            >
              {t("header.connectWallet")}
            </button>
          )}

          {/* Mobile: wallet status pill */}
          {isConnected && (
            <div className="md:hidden flex items-center gap-1">
              <span className="text-xs font-mono text-nav-foreground bg-surface border border-border px-2 py-1">
                {truncatedAddress}
              </span>
              {publicKey && (
                <CopyButton
                  value={publicKey}
                  label="Copy wallet address"
                  confirmText="Copied!"
                  size="sm"
                />
              )}
            </div>
          )}

          {/* Hamburger */}
          <button
            className="md:hidden flex flex-col justify-center items-center w-8 h-8 gap-1.5 text-foreground"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? t("header.closeMenu") : t("header.openMenu")}
            data-testid="mobile-menu-toggle"
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
                data-testid={`mobile-nav-link-${item.href.slice(1)}`}
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
                {t(item.labelKey)}
              </Link>
            ))}
            {isConnected && (
              <Link
                href="/dashboard"
                onClick={() => setMenuOpen(false)}
                data-testid="mobile-nav-link-dashboard"
                className={`flex items-center px-2 py-3 text-sm border-b border-border/50 ${
                  pathname === "/dashboard" ? "text-nav-accent" : "text-muted"
                }`}
              >
                {t("header.dashboard")}
              </Link>
            )}
            <Link
              href="/launch"
              onClick={() => setMenuOpen(false)}
              data-testid="mobile-nav-link-launch"
              className="flex items-center px-2 py-3 text-sm text-accent font-medium border-b border-border/50"
            >
              {t("header.launchpadArrow")}
            </Link>
            <div className="pt-3 pb-2">
              {isConnected ? (
                <button
                  onClick={() => { disconnect(); setMenuOpen(false); }}
                  data-testid="mobile-disconnect-wallet-button"
                  className="text-xs text-muted hover:text-foreground transition-colors"
                >
                  {t("header.disconnectWallet")}
                </button>
              ) : (
                <button
                  onClick={() => { connect(); setMenuOpen(false); }}
                  data-testid="mobile-connect-wallet-button"
                  className="w-full border border-border py-2.5 text-sm text-foreground hover:bg-surface transition-colors"
                >
                  {t("header.connectWallet")}
                </button>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
