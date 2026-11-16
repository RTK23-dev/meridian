import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, errorText } from "@/components/ui";
import { AuthShell } from "@/components/settings/auth-shell";
import { PasswordField } from "@/components/settings/email-auth-form";
import { FormError } from "@/components/settings/form-error";
import { plainResetError, plainServerError, resetPasswordSchema, type ResetPasswordValues } from "@/components/settings/form-model";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { authClient } from "@/lib/auth/client";

export const Route = createFileRoute("/reset-password")({
  staticData: { pageTitle: "Reset password" },
  head: () => ({ meta: [{ title: "Reset password · Meridian" }] }),
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" && search.token.length > 0 ? search.token : undefined,
  }),
  component: ResetPassword,
});

const LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sharp text-sm font-semibold text-fg-primary underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function ResetPassword() {
  const { token } = Route.useSearch();
  const [failure, setFailure] = useState<{ message: string; raw: string } | null>(null);
  const [done, setDone] = useState(false);
  const form = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: "" }, mode: "onBlur" });

  async function submit(values: ResetPasswordValues) {
    setFailure(null);
    if (!token) return;
    try {
      const result = await authClient.resetPassword({ newPassword: values.password, token });
      if (result.error) {
        setFailure({ message: plainResetError(result.error), raw: result.error.message ?? result.error.code ?? "" });
        return;
      }
      setDone(true);
    } catch (caught) {
      const raw = errorText(caught);
      setFailure({ message: plainServerError(raw, "sign-in"), raw });
    }
  }

  return (
    <AuthShell title="Choose a new password" description="The link you opened works once.">
      {done ? (
        <div className="space-y-4">
          <p role="status" className="text-sm text-fg-primary">Your password is changed. Sign in with the new one.</p>
          <Link to="/login" className={LINK_CLASS}>Go to sign in</Link>
        </div>
      ) : !token ? (
        <div className="space-y-4">
          <FormError message="This reset link is incomplete. Open the link from the email again, or ask for a new one on the sign-in page." />
          <Link to="/login" className={LINK_CLASS}>Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="space-y-4" noValidate>
          <PasswordField
            label="New password"
            hint="At least 8 characters."
            registration={form.register("password")}
            error={form.formState.errors.password?.message}
            autoComplete="new-password"
          />
          {failure ? <FormError message={failure.message} raw={failure.raw} /> : null}
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Set new password"}
          </Button>
          {failure ? <Link to="/login" className={LINK_CLASS}>Back to sign in</Link> : null}
        </form>
      )}
    </AuthShell>
  );
}
