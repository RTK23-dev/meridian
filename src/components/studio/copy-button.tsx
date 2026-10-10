import { useState } from "react";
import { Button } from "@/components/ui";

/** Copies a stored value, such as a publisher id. The result is announced as text, and a failure says what to do. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="secondary" aria-label={`Copy ${label}`} onClick={() => void copy()}>
        Copy
      </Button>
      <span role="status" className="text-xs text-fg-muted">
        {result === "copied" ? "Copied." : result === "failed" ? "Copy failed. Select the id and copy it by hand." : ""}
      </span>
    </span>
  );
}
