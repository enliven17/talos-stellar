import pino from "pino";
import { redactPayload } from "./redact";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    log: (obj) => redactPayload(obj),
  },
  ...(process.env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});
