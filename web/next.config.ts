import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // pnpm workspace: next is a symlink → ../../node_modules/.pnpm/…
    // Turbopack follows symlinks, so root must include the monorepo root
    // to avoid "files outside of project directory" security restriction.
    root: path.resolve(__dirname, ".."),
  },
};

export default nextConfig;
