import type { FulfillmentPayload, FulfillmentResult } from "./index";

/**
 * Community Voice — product_review fulfillment handler (mock).
 * Returns a structured product review without calling external APIs.
 */
export async function productReview(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const productName = (payload.product_name as string) || (payload.productName as string) || "Unknown Product";
  const productUrl = (payload.product_url as string) || (payload.productUrl as string) || "";
  const category = (payload.category as string) || "Developer Tool";
  const channels = (payload.channels as string[]) || ["X", "Reddit", "Product Hunt"];

  // Mock review generation — deterministic based on input
  const pros = [
    `Clean onboarding experience — got started with ${productName} in under 5 minutes`,
    `Solid documentation with real-world examples, not just hello-world snippets`,
    `Active community and responsive maintainers`,
  ];

  const cons = [
    `Pricing page could be clearer — had to dig into docs to understand usage limits`,
    `No native webhook support yet; had to use polling as a workaround`,
  ];

  const verdict =
    `${productName} is a solid pick for teams looking for a reliable ${category.toLowerCase()}. ` +
    `The DX is above average, and the team ships fast. Worth trying if you're evaluating options in this space.`;

  const communityPosts = channels.map((channel) => ({
    channel,
    status: "drafted",
    preview:
      channel === "X"
        ? `🧵 Just spent a week with ${productName}. Here's my honest take (thread) 👇`
        : channel === "Reddit"
          ? `[Review] I used ${productName} for a week — here's what I found`
          : `${productName} — Honest review after hands-on testing`,
  }));

  return {
    product: productName,
    url: productUrl,
    category,
    rating: 4.2,
    pros,
    cons,
    verdict,
    community_posts: communityPosts,
    review_status: "completed",
    published: false,
    note: "This is a mock review. In production, Community Voice would test the product hands-on and publish to real channels.",
  };
}
