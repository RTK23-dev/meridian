import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
  Button, Field, TextInput, errorText,
} from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { useWorkspace } from "@/components/workspace";
import { deleteBrand } from "@/lib/meridian/api";
import { useScopedMutation } from "@/lib/query/hooks";

/** Deleting a brand needs its exact name typed into the dialog. The dialog stays open if the server refuses. */
export function DangerZone({ brandId, brandName }: { brandId: string; brandName: string }) {
  const navigate = useNavigate();
  const { reload } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const removeBrand = useScopedMutation({
    mutationKey: ["mutation", "brand.delete", brandId],
    mutationFn: () => deleteBrand({ data: { brandId } }),
    success: "Brand deleted.",
    onSuccess: async () => {
      await reload();
      await navigate({ to: "/" });
    },
  });
  const matches = typed === brandName;
  const rawError = removeBrand.error ? errorText(removeBrand.error) : null;

  return (
    <section aria-labelledby="danger-zone-title" className="space-y-3 rounded-lg border border-danger/40 bg-surface p-5">
      <h2 id="danger-zone-title" className="text-base font-semibold text-fg">Danger zone</h2>
      <p className="text-sm text-fg-muted">Deleting this brand removes it from your workspace and leaves an audit record.</p>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped("");
            removeBrand.reset();
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="danger">Delete brand</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete {brandName}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone from Meridian. Type the brand name exactly to confirm.</AlertDialogDescription>
          <div className="mt-4 space-y-4">
            <Field label={`Type “${brandName}” to confirm`} hint={matches ? "The name matches." : "Type the name exactly as shown above."}>
              <TextInput value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
            </Field>
            {rawError ? <FormError message={plainServerError(rawError, "brand")} raw={rawError} /> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <AlertDialogCancel asChild>
                <Button variant="secondary">Cancel</Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  variant="danger"
                  disabled={!matches || removeBrand.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    void removeBrand.mutateAsync().catch(() => undefined);
                  }}
                >
                  {removeBrand.isPending ? "Deleting…" : "Delete brand"}
                </Button>
              </AlertDialogAction>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
