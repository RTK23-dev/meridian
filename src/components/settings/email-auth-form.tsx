import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { Button, Field, Input, errorText } from "@/components/ui";
import { authClient } from "@/lib/auth/client";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { FormError } from "./form-error";
import { requestPasswordResetEmail } from "@/lib/auth/password-reset.functions";
import {
  plainAuthError,
  plainServerError,
  resetRequestSchema,
  signInSchema,
  signUpSchema,
  type ResetRequestValues,
  type SignInValues,
  type SignUpValues,
} from "./form-model";

type Failure = { message: string; raw: string };

/** Email and password, with sign-in and create-account as two forms. Each has its own schema, so inline checks match the mode. */
/** Where a person lands after signing in: the invitation they opened, if that is where they are, else the workspace. */
function afterSignIn(): string {
  const { pathname, search } = window.location;
  return pathname.replace(/\/+$/, "") === "/invite" && search.includes("token=") ? `${pathname}${search}` : "/";
}

export function EmailAuthForm({ initialMode = "up" }: { initialMode?: "in" | "up" }) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">(initialMode);
  return (
    <div className="space-y-5">
      {mode === "in" ? <SignInForm onForgot={() => setMode("forgot")} /> : mode === "forgot" ? <ForgotPasswordForm /> : <SignUpForm />}
      <button
        type="button"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-fg-primary underline underline-offset-4 hover:no-underline"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "Create an account instead" : mode === "forgot" ? "Back to sign in" : "I already have an account"}
      </button>
    </div>
  );
}

function SignInForm({ onForgot }: { onForgot: () => void }) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const form = useForm<SignInValues>({ resolver: zodResolver(signInSchema), defaultValues: { email: "", password: "" }, mode: "onBlur" });
  async function submit(values: SignInValues) {
    setFailure(null);
    try {
      const result = await authClient.signIn.email({ email: values.email, password: values.password });
      if (result.error) {
        setFailure({ message: plainAuthError(result.error, "sign-in"), raw: result.error.message ?? result.error.code ?? "" });
        return;
      }
      window.location.assign(afterSignIn());
    } catch (caught) {
      const raw = errorText(caught);
      setFailure({ message: plainServerError(raw, "sign-in"), raw });
    }
  }
  return (
    <form onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="space-y-4" noValidate>
      <EmailField registration={form.register("email")} error={form.formState.errors.email?.message} autoComplete="email" />
      <PasswordField
        label="Password"
        registration={form.register("password")}
        error={form.formState.errors.password?.message}
        autoComplete="current-password"
      />
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-sharp text-sm font-semibold text-fg-primary underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={onForgot}
      >
        Forgot your password?
      </button>
      {failure ? <FormError message={failure.message} raw={failure.raw} /> : null}
      <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Signing in…" : "Sign in with email"}
      </Button>
    </form>
  );
}

/** Asks for a reset link. The answer is the same for every address; when the server cannot send email it says so. */
function ForgotPasswordForm() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const form = useForm<ResetRequestValues>({ resolver: zodResolver(resetRequestSchema), defaultValues: { email: "" }, mode: "onBlur" });
  async function submit(values: ResetRequestValues) {
    setFailure(null);
    setDone(null);
    try {
      const answer = await requestPasswordResetEmail({ data: { email: values.email } });
      if (answer.status === "requested") setDone(answer.message);
      else setFailure({ message: answer.message, raw: answer.message });
    } catch (caught) {
      const raw = errorText(caught);
      setFailure({ message: plainServerError(raw, "sign-in"), raw });
    }
  }
  return (
    <form onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="space-y-4" noValidate>
      <p className="text-sm text-fg-muted">Enter the email you signed up with. If it has an account, we send a link to choose a new password.</p>
      <EmailField registration={form.register("email")} error={form.formState.errors.email?.message} autoComplete="email" />
      {failure ? <FormError message={failure.message} raw={failure.raw} /> : null}
      {done ? <p role="status" className="rounded-sharp border border-hairline p-3 text-sm text-fg-primary">{done}</p> : null}
      <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}

function SignUpForm() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const form = useForm<SignUpValues>({ resolver: zodResolver(signUpSchema), defaultValues: { name: "", email: "", password: "" }, mode: "onBlur" });
  async function submit(values: SignUpValues) {
    setFailure(null);
    try {
      const result = await authClient.signUp.email({ name: values.name, email: values.email, password: values.password });
      if (result.error) {
        setFailure({ message: plainAuthError(result.error, "sign-up"), raw: result.error.message ?? result.error.code ?? "" });
        return;
      }
      window.location.assign(afterSignIn());
    } catch (caught) {
      const raw = errorText(caught);
      setFailure({ message: plainServerError(raw, "sign-up"), raw });
    }
  }
  return (
    <form onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="space-y-4" noValidate>
      <Field label="Your name" error={form.formState.errors.name?.message} required>
        <Input {...form.register("name")} autoComplete="name" maxLength={80} />
      </Field>
      <EmailField registration={form.register("email")} error={form.formState.errors.email?.message} autoComplete="email" />
      <PasswordField
        label="Password"
        hint="At least 8 characters."
        registration={form.register("password")}
        error={form.formState.errors.password?.message}
        autoComplete="new-password"
      />
      {failure ? <FormError message={failure.message} raw={failure.raw} /> : null}
      <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

function EmailField({ registration, error, autoComplete }: { registration: UseFormRegisterReturn; error?: string; autoComplete: string }) {
  return (
    <Field label="Email" error={error} required>
      <Input {...registration} type="email" inputMode="email" autoComplete={autoComplete} maxLength={200} />
    </Field>
  );
}

/** The show and hide control is a labelled toggle with aria-pressed. Its touch target is 44 px on every width. */
export function PasswordField({ label, hint, error, registration, autoComplete }: {
  label: string;
  hint?: string;
  error?: string;
  registration: UseFormRegisterReturn;
  autoComplete: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint} error={error} required>
      <div className="relative">
        <Input {...registration} type={visible ? "text" : "password"} autoComplete={autoComplete} maxLength={128} className="pr-24" />
        <PasswordToggle visible={visible} onToggle={() => setVisible((current) => !current)} />
      </div>
    </Field>
  );
}

function PasswordToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label="Show password"
      aria-pressed={visible}
      onClick={onToggle}
      className="absolute right-1 top-1/2 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-sharp px-3 text-sm font-semibold text-fg-primary hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {visible ? "Hide" : "Show"}
    </button>
  );
}
