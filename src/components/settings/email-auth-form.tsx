import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { Button, Field, TextInput, errorText } from "@/components/ui";
import { authClient } from "@/lib/auth/client";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { FormError } from "./form-error";
import { plainAuthError, plainServerError, signInSchema, signUpSchema, type SignInValues, type SignUpValues } from "./form-model";

type Failure = { message: string; raw: string };

/** Email and password, with sign-in and create-account as two forms. Each has its own schema, so inline checks match the mode. */
export function EmailAuthForm({ initialMode = "up" }: { initialMode?: "in" | "up" }) {
  const [mode, setMode] = useState<"in" | "up">(initialMode);
  return (
    <div className="space-y-5">
      {mode === "in" ? <SignInForm /> : <SignUpForm />}
      <button
        type="button"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "Create an account instead" : "I already have an account"}
      </button>
    </div>
  );
}

function SignInForm() {
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
      window.location.assign("/");
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
      {failure ? <FormError message={failure.message} raw={failure.raw} /> : null}
      <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Signing in…" : "Sign in with email"}
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
      window.location.assign("/");
    } catch (caught) {
      const raw = errorText(caught);
      setFailure({ message: plainServerError(raw, "sign-up"), raw });
    }
  }
  return (
    <form onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="space-y-4" noValidate>
      <Field label="Your name" error={form.formState.errors.name?.message} required>
        <TextInput {...form.register("name")} autoComplete="name" maxLength={80} />
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
      <TextInput {...registration} type="email" inputMode="email" autoComplete={autoComplete} maxLength={200} />
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
        <TextInput {...registration} type={visible ? "text" : "password"} autoComplete={autoComplete} maxLength={128} className="pr-24" />
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
      className="absolute right-1 top-1/2 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-md px-3 text-sm font-semibold text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {visible ? "Hide" : "Show"}
    </button>
  );
}
