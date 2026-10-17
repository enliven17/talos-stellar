import { DeadLetterClient } from "./dead-letter-client";

export const metadata = {
  title: "Outbox Dead Letters — Talos",
  description: "Operator view of outbox events whose delivery failed permanently",
};

export default function AdminOutboxDeadLetterPage() {
  return <DeadLetterClient />;
}
