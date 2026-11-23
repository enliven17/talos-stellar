import { WebhooksClient } from "./webhooks-client";

export const metadata = {
  title: "Webhook Subscriptions — Talos",
  description:
    "Create, inspect, rotate and delete TALOS webhook subscriptions and review recent delivery attempts",
};

export default function WebhooksPage() {
  return <WebhooksClient />;
}
