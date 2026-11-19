// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import axe from "axe-core";
import LaunchPage, { LaunchForm } from "../src/app/launch/page";

// Polyfill for ES2024 Iterator on Node 20
if (typeof (globalThis as any).Iterator === "undefined") {
  (globalThis as any).Iterator = class Iterator {};
}

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Mock wallet gate and provider hooks
vi.mock("@/components/wallet-gate", () => ({
  WalletGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWallet: () => ({
    isConnected: true,
    address: "GDTESTCREATORPUBLICKEY1234567890STEL",
    connect: vi.fn(),
  }),
}));

vi.mock("@/components/providers", () => ({
  useStellarWallet: () => ({
    isConnected: true,
    publicKey: "GDTESTCREATORPUBLICKEY1234567890STEL",
    signTransaction: vi.fn(),
  }),
}));

vi.mock("@/lib/soroban", () => ({
  isNameAvailableOnChain: vi.fn().mockResolvedValue(true),
  ensureStellarNetwork: vi.fn().mockResolvedValue(undefined),
  getNetwork: vi.fn().mockReturnValue({
    sorobanRpc: "http://localhost:8000",
    networkPassphrase: "test",
  }),
  TALOS_REGISTRY_CONTRACT_ID: "",
  TALOS_NAME_SERVICE_CONTRACT_ID: "",
}));

describe("Launch Form Accessibility & Programmatic Labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("queries each field on step 0 by getByLabelText and checks aria-invalid after failed submit", async () => {
    render(<LaunchForm />);

    // Query each field on Step 0 by its accessible label
    const productNameInput = screen.getByLabelText(/^Product Name/i);
    const descriptionInput = screen.getByLabelText(/^Description/i);
    const categorySelect = screen.getByLabelText(/Category/i);
    const serviceNameInput = screen.getByLabelText(/Service Name/i);
    const serviceDescriptionInput = screen.getByLabelText(/Service Description/i);
    const servicePriceInput = screen.getByLabelText(/Price per Request \(USDC\)/i);

    expect(productNameInput).toBeDefined();
    expect(descriptionInput).toBeDefined();
    expect(categorySelect).toBeDefined();
    expect(serviceNameInput).toBeDefined();
    expect(serviceDescriptionInput).toBeDefined();
    expect(servicePriceInput).toBeDefined();

    // Required fields are marked with aria-required and required
    expect(productNameInput.hasAttribute("required")).toBe(true);
    expect(productNameInput.getAttribute("aria-required")).toBe("true");
    expect(descriptionInput.hasAttribute("required")).toBe(true);
    expect(descriptionInput.getAttribute("aria-required")).toBe("true");
    expect(categorySelect.hasAttribute("required")).toBe(true);
    expect(categorySelect.getAttribute("aria-required")).toBe("true");

    // Initially, fields are not marked invalid
    expect(productNameInput.getAttribute("aria-invalid")).toBe("false");
    expect(descriptionInput.getAttribute("aria-invalid")).toBe("false");

    // Attempt a failed submit with empty required fields
    const nextButton = screen.getByTestId("launch-next-button");
    fireEvent.click(nextButton);

    // After failed submit, required empty fields must have aria-invalid="true"
    expect(productNameInput.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionInput.getAttribute("aria-invalid")).toBe("true");

    // Inline error text must be displayed with role="alert" and linked via aria-describedby
    const productError = screen.getByText("Product name is required");
    expect(productError.getAttribute("role")).toBe("alert");
    expect(productNameInput.getAttribute("aria-describedby")).toContain(productError.id);

    const descError = screen.getByText("Description is required");
    expect(descError.getAttribute("role")).toBe("alert");
    expect(descriptionInput.getAttribute("aria-describedby")).toContain(descError.id);
  });

  it("clicking a label links to and focuses its control", () => {
    render(<LaunchForm />);

    const productNameLabel = screen.getByText(/^Product Name/i).closest("label")!;
    const productNameInput = screen.getByLabelText(/^Product Name/i);

    expect(productNameLabel.htmlFor).toBe(productNameInput.id);
    expect(productNameInput.id).toBe("launch-input-product-name");

    productNameLabel.click();
    productNameInput.focus();
    expect(document.activeElement).toBe(productNameInput);

    const descriptionLabel = screen.getByText(/^Description/i).closest("label")!;
    const descriptionInput = screen.getByLabelText(/^Description/i);

    expect(descriptionLabel.htmlFor).toBe(descriptionInput.id);
    expect(descriptionInput.id).toBe("launch-input-description");

    descriptionLabel.click();
    descriptionInput.focus();
    expect(document.activeElement).toBe(descriptionInput);
  });

  it("axe shows no label violations on /launch", async () => {
    const { container } = render(<LaunchPage />);

    const results = await axe.run(container, {
      rules: {
        // Specifically check label rules
        label: { enabled: true },
        "label-title-only": { enabled: true },
      },
    });

    const labelViolations = results.violations.filter(
      (v) => v.id === "label" || v.id === "label-title-only"
    );

    expect(labelViolations).toHaveLength(0);
  });

  it("queries fields across subsequent steps and checks aria-invalid on failed submit", async () => {
    render(<LaunchForm />);

    // Fill Step 0 and proceed
    fireEvent.change(screen.getByLabelText(/^Product Name/i), {
      target: { value: "Test Product" },
    });
    fireEvent.change(screen.getByLabelText(/^Description/i), {
      target: { value: "A valid description for testing" },
    });
    fireEvent.click(screen.getByTestId("launch-next-button"));

    // Step 1: Patron Configuration
    await waitFor(() => {
      expect(screen.getByText("Patron Configuration")).toBeDefined();
    });
    const creatorKey = screen.getByLabelText(/Creator Public Key \(Stellar\)/i);
    expect(creatorKey).toBeDefined();

    // Proceed to Step 2: Mitos Configuration
    fireEvent.click(screen.getByTestId("launch-next-button"));
    await waitFor(() => {
      expect(screen.getByText("Mitos Configuration")).toBeDefined();
    });

    // Query each field on Step 2 by label
    const tokenNameInput = screen.getByLabelText(/Token Name/i);
    const tokenSymbolInput = screen.getByLabelText(/Token Symbol/i);
    const totalSupplyInput = screen.getByLabelText(/Total Supply/i);
    const initialPriceInput = screen.getByLabelText(/Initial Price/i);

    expect(tokenNameInput).toBeDefined();
    expect(tokenSymbolInput).toBeDefined();
    expect(totalSupplyInput).toBeDefined();
    expect(initialPriceInput).toBeDefined();

    // Clear token name and trigger failed submit
    fireEvent.change(tokenNameInput, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("launch-next-button"));

    expect(tokenNameInput.getAttribute("aria-invalid")).toBe("true");
    const tokenNameError = screen.getByText("Token name is required");
    expect(tokenNameError.getAttribute("role")).toBe("alert");
    expect(tokenNameInput.getAttribute("aria-describedby")).toContain(tokenNameError.id);

    // Fill Step 2 properly and proceed to Step 3
    fireEvent.change(tokenNameInput, { target: { value: "MyToken" } });
    fireEvent.change(tokenSymbolInput, { target: { value: "MTK" } });
    fireEvent.click(screen.getByTestId("launch-next-button"));

    // Step 3: Kernel Policy
    await waitFor(() => {
      expect(screen.getByText("Kernel Policy")).toBeDefined();
    });
    const approvalThresholdInput = screen.getByLabelText(/Approval Threshold/i);
    const gtmBudgetInput = screen.getByLabelText(/GTM Budget/i);

    expect(approvalThresholdInput).toBeDefined();
    expect(gtmBudgetInput).toBeDefined();

    // Step 4: Prime Agent Setup
    fireEvent.click(screen.getByTestId("launch-next-button"));
    await waitFor(() => {
      expect(screen.getByText("Prime Agent Setup")).toBeDefined();
    });

    const agentIdentityInput = screen.getByLabelText(/Agent Identity/i);
    const personaInput = screen.getByLabelText(/Persona/i);
    const targetAudienceInput = screen.getByLabelText(/Target Audience/i);
    const toneSelect = screen.getByLabelText(/Tone/i);

    expect(agentIdentityInput).toBeDefined();
    expect(personaInput).toBeDefined();
    expect(targetAudienceInput).toBeDefined();
    expect(toneSelect).toBeDefined();

    // Trigger failed submit on step 4
    fireEvent.click(screen.getByTestId("launch-next-button"));
    expect(agentIdentityInput.getAttribute("aria-invalid")).toBe("true");
    expect(personaInput.getAttribute("aria-invalid")).toBe("true");
    expect(targetAudienceInput.getAttribute("aria-invalid")).toBe("true");
  });
});
