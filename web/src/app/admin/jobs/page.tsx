import { JobsClient } from "./jobs-client";

export const metadata = {
  title: "Background Jobs — Talos",
  description: "Operator view for inspecting, filtering, cancelling, and retrying durable background jobs",
};

export default function AdminJobsPage() {
  return <JobsClient />;
}
