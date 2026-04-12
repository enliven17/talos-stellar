import type { Metadata } from "next";
import { Ruthie } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";
import { Providers } from "@/components/providers";
import { SplashScreen } from "@/components/splash-screen";

const ruthie = Ruthie({
  variable: "--font-ruthie",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Talos",
  description: "The operating system for autonomous agent corporations on Stellar",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${ruthie.variable} h-full antialiased bg-background`} style={{ colorScheme: "light", backgroundColor: "#FCF8F8" }}>
      <body className="min-h-full flex flex-col bg-background text-foreground font-mono" style={{ backgroundColor: "#FCF8F8" }}>
        <SplashScreen />
        <Providers>
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
