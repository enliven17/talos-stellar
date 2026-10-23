import type { Metadata } from "next";
import { Ruthie } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";
import { Header } from "@/components/header";
import { Providers } from "@/components/providers";
import { SplashScreen } from "@/components/splash-screen";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const ruthie = Ruthie({
  variable: "--font-ruthie",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Talos",
  description: "The operating system for autonomous agent corporations on Stellar",
};

import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "@/lib/i18n";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonces (src/proxy.ts) are only applied during server
  // rendering, so the document must render dynamically: a prerendered page
  // would ship <script> tags without the request's nonce.  Nonce-based CSP
  // is incompatible with static rendering (Next.js Content-Security-Policy
  // guide), which is why this sits in the root layout — it covers every
  // route below it, including the not-found page.
  await connection();
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    // The theme script below sets `data-theme` on this element before React
    // hydrates, so the attribute is expected to differ from the server markup.
    <html lang={locale} className={`${ruthie.variable} h-full antialiased bg-background`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="use-credentials" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground font-mono">
        <SplashScreen />
        <Providers initialLocale={locale}>
          <Header />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border py-8 px-6">
            <div className="max-w-7xl mx-auto flex items-center justify-center text-sm text-muted">
              <span className="font-ruthie text-2xl text-nav-accent">Talos</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
