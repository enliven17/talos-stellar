import type { Metadata } from "next";

import ReconcilerClient from "./reconciler-client";

export const metadata: Metadata = {
  title: "Reconciler — Admin",
  description: "Stellar finality reconciler status and records",
};

export default function ReconcilerAdminPage() {
  return (
    <main className="mx-auto w-full max-w-6l px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Reconciler
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Stellar finality reconciler health, stuck payments, and manual tick triggering.
        </p>
      </header>
      <ReconcilerClient />
    </main>
  );
}
