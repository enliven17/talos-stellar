import { audienceInsight } from "./audience-insight";
import { trendResearch } from "./trend-research";
import { competitorAnalysis } from "./competitor-analysis";
import { findLeads } from "./find-leads";
import { enrichProfile } from "./enrich-profile";
import { intentSignal } from "./intent-signal";
import { productReview } from "./product-review";

export type FulfillmentPayload = Record<string, unknown>;
export type FulfillmentResult = Record<string, unknown>;

type Handler = (payload: FulfillmentPayload) => Promise<FulfillmentResult>;

const handlers: Record<string, Handler> = {
  audience_insight: audienceInsight,
  trend_research: trendResearch,
  competitor_analysis: competitorAnalysis,
  find_leads: findLeads,
  enrich_profile: enrichProfile,
  intent_signal: intentSignal,
  product_review: productReview,
};

export async function fulfillInstant(
  serviceName: string,
  payload: FulfillmentPayload,
): Promise<FulfillmentResult> {
  const handler = handlers[serviceName];
  if (!handler) {
    throw new Error(`No instant fulfillment handler for service: ${serviceName}`);
  }
  return handler(payload);
}
