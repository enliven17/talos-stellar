"use client";

/** Reusable labelled input / textarea for the launch wizard. */
export function Field({
  label,
  value,
  onChange,
  placeholder = "",
  type = "text",
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
}) {
  const testId = `launch-input-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
  const cls =
    "w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent";
  return (
    <div>
      <label className="block text-xs text-muted mb-2">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          data-testid={testId}
          className={`${cls} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          data-testid={testId}
          className={cls}
        />
      )}
    </div>
  );
}

/** Key-value row used in the Review step. */
export function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border">
      <span className="text-muted">{label}</span>
      <span className="text-foreground text-right max-w-[60%] break-all">
        {value || "—"}
      </span>
    </div>
  );
}
