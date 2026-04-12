import type { Metadata } from "next";
import { Geist_Mono, Playfair_Display, Pinyon_Script, Ruthie } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";
import { Providers } from "@/components/providers";

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const pinyon = Pinyon_Script({
  variable: "--font-pinyon",
  subsets: ["latin"],
  weight: "400",
});

const ruthie = Ruthie({
  variable: "--font-ruthie",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "TALOS Protocol",
  description: "The operating system for autonomous agent corporations on Stellar",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${mono.variable} ${playfair.variable} ${pinyon.variable} ${ruthie.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground font-mono">
        <Providers>
          <Header />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border py-8 px-6">
            <div className="max-w-7xl mx-auto flex items-center justify-between text-sm text-muted">
              <span>TALOS Protocol</span>
              <div className="flex gap-6">
                <a href="#" className="hover:text-foreground transition-colors">Docs</a>
                <a href="#" className="hover:text-foreground transition-colors">GitHub</a>
                <a href="#" className="hover:text-foreground transition-colors">Twitter</a>
              </div>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
