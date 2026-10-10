import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogTitle, AlertDialogTrigger, Button, Field, TextInput, errorText,
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
  // The typed name is checked by the same rule every time it changes, so the Delete button follows the field.
  const confirmSchema = useMemo(() => z.object({
    confirmName: z.string().refine((value) => value === brandName, "Type the name exactly as shown above."),
  }), [brandName]);
  const confirmForm = useForm<{ confirmName: string }>({ resolver: zodResolver(confirmSchema), defaultValues: { confirmName: "" }, mode: "onChange" });
  const typed = confirmForm.watch("confirmName");
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
            confirmForm.reset({ confirmName: "" });
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
            <Field label={`Type “${brandName}” to confirm`} hint={matches ? "The name matches." : "Capitals and spaces count."} error={typed && !matches ? "Type the name exactly as shown above." : undefined}>
              <TextInput {...confirmForm.register("confirmName")} autoComplete="off" />
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
