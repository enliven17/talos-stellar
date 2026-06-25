import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <Link href="/" className="text-nav-accent text-4xl font-ruthie mb-10">
        Talos
      </Link>

      <div className="text-xs text-muted mb-4 tracking-wide">// 404</div>

      <h1 className="text-2xl font-bold text-accent mb-3">Page not found</h1>

      <p className="text-sm text-muted max-w-sm mb-10 leading-relaxed">
        This route does not exist. It may have moved or never existed.
      </p>

      <Link
        href="/"
        className="bg-accent text-background px-6 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
      >
        Go home
      </Link>
    </div>
  );
}
