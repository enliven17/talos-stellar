const LOCAL_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "db",
  "host.docker.internal",
]);

export const SEED_UNSAFE_DATABASE_OVERRIDE = "ALLOW_UNSAFE_DB_SEED";

export function assertSafeSeedDatabaseUrl(
  databaseUrl: string | undefined,
  options: { nodeEnv?: string; allowUnsafe?: string } = {},
): void {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const allowUnsafe =
    options.allowUnsafe ?? process.env[SEED_UNSAFE_DATABASE_OVERRIDE];

  if (!databaseUrl) {
    throw new Error(
      "Refusing to seed: DATABASE_URL is not set. Point it at the local development database.",
    );
  }

  if (allowUnsafe === "true") return;

  if (nodeEnv === "production") {
    throw new Error(
      `Refusing to seed a production process. Set ${SEED_UNSAFE_DATABASE_OVERRIDE}=true only for an intentional, reviewed override.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Refusing to seed: DATABASE_URL is not a valid PostgreSQL URL. Use the local development connection string.",
    );
  }

  if (!parsed.protocol.startsWith("postgres")) {
    throw new Error(
      "Refusing to seed: DATABASE_URL must use a PostgreSQL protocol and point at a local development database.",
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to seed database host '${hostname}'. Use localhost, 127.0.0.1, ::1, or the local Docker postgres service. Set ${SEED_UNSAFE_DATABASE_OVERRIDE}=true only for an intentional, reviewed override.`,
    );
  }
}
