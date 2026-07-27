import path from "path";
import { fileURLToPath } from "url";
import { withSentryConfig } from "@sentry/nextjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nextConfig = {
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: "/api/:path*",
      },
    ];
  },
};

const config = withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  widenClientFileUpload: false,
  disableLogger: true,
  automaticVercelMonitors: false,
});

export default config;
