import { splitOperatorHint } from "./key-copy";

/** A reason in plain words, with any server variable names in it moved behind a note for whoever runs the server. */
export function OperatorReason({ text, className = "text-sm text-fg-muted [overflow-wrap:anywhere]" }: { text: string; className?: string }) {
  const reason = splitOperatorHint(text);
  return (
    <div className="space-y-1">
      <p className={className}>{reason.plain}</p>
      {reason.operator ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">For whoever runs the server</summary>
          <p className="mt-1 font-mono [overflow-wrap:anywhere]">{reason.operator}</p>
        </details>
      ) : null}
    </div>
  );
}

/** The server variable names a deployment-only row is set with. They are shown only inside the operator note. */
export function OperatorVariables({ names, lead }: { names: readonly string[]; lead: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-fg-muted">{lead}</p>
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer">For whoever runs the server</summary>
        <p className="mt-1 [overflow-wrap:anywhere]">
          Set {names.map((name, index) => (
            <span key={name}>{index > 0 ? ", " : ""}<code className="font-mono text-fg">{name}</code></span>
          ))} in the server&apos;s environment. No key is shown on this page.
        </p>
      </details>
    </div>
  );
}
