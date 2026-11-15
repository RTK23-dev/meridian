/**
 * Says, before a person tries, that an action is switched off in this version and what to do instead. The server refuses the action
 * either way; this keeps the screen from offering something that cannot work.
 */
export function OffNotice({ what, instead }: { what: string; instead: string }) {
  return (
    <p role="note" className="rounded-sharp border border-border-strong p-3 text-sm text-fg-primary">
      <span className="font-semibold">{what} is switched off in this version.</span> {instead}
    </p>
  );
}
