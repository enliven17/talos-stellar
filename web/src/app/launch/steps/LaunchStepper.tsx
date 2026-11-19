"use client";

const STEPS = [
  "Product",
  "Patron",
  "Mitos",
  "Kernel",
  "Agent",
  "Review",
] as const;

interface LaunchStepperProps {
  currentStep: number;
  onStepClick: (index: number) => void;
}

export function LaunchStepper({ currentStep, onStepClick }: LaunchStepperProps) {
  return (
    <div className="flex items-center gap-1 mb-10 overflow-x-auto">
      {STEPS.map((s, i) => (
        <button
          key={s}
          onClick={() => i <= currentStep && onStepClick(i)}
          data-testid={`launch-step-${s.toLowerCase()}`}
          className={`px-3 py-1.5 text-xs border transition-colors whitespace-nowrap ${
            i === currentStep
              ? "border-accent text-accent bg-surface"
              : i < currentStep
                ? "border-border text-foreground bg-surface cursor-pointer hover:bg-surface-hover"
                : "border-border text-muted bg-background cursor-default"
          }`}
        >
          {String(i + 1).padStart(2, "0")} {s}
        </button>
      ))}
    </div>
  );
}
