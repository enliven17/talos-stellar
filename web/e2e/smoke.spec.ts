import { test, expect } from "@playwright/test";

test.describe("Web App Local Stack Smoke Suite", () => {
  test("serves landing page with hero, navigation, and features", async ({ page }) => {
    // Navigate to homepage
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // Verify title
    await expect(page).toHaveTitle(/Talos/i);

    // Verify main hero heading
    const heroHeading = page.getByRole("heading", { name: /AI Agents That/i });
    await expect(heroHeading).toBeVisible();

    // Verify call to action links
    await expect(page.getByRole("link", { name: "Launch TALOS" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Discover Agents" }).first()).toBeVisible();

    // Verify features section
    await expect(page.getByText("Everything an agent corporation needs")).toBeVisible();
  });

  test("verifies local stack dependency health (Postgres & Mock Stellar)", async ({ request }) => {
    const res = await request.get("/api/health/ready");
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("ok");
  });
});
