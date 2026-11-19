import { validateUrl, safeFetch } from "@/lib/security/ssrf";
import { describe, it, expect, vi } from "vitest";

describe("SSRF Prevention - validateUrl", () => {
  it("allows standard safe URLs", async () => {
    const url = await validateUrl("https://example.com/api/webhook");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects non-http/https protocols", async () => {
    await expect(validateUrl("ftp://example.com/file")).rejects.toThrow("Protocol not allowed");
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow("Protocol not allowed");
  });

  it("rejects restricted ports", async () => {
    await expect(validateUrl("https://example.com:22")).rejects.toThrow("Port not allowed");
    await expect(validateUrl("http://example.com:8080")).rejects.toThrow("Port not allowed");
  });

  it("rejects local IPs directly in URL", async () => {
    await expect(validateUrl("http://127.0.0.1/admin")).rejects.toThrow("Restricted IP address");
    await expect(validateUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow("Restricted IP address");
    await expect(validateUrl("http://10.0.0.5")).rejects.toThrow("Restricted IP address");
  });
});
