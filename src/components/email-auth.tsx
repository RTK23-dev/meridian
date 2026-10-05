import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { Button, Field, Notice, TextInput } from "@/components/ui";
import { errorText } from "@/components/ui";

export function EmailAuth() {
  const [mode, setMode] = useState<"up" | "in">("up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result =
        mode === "up"
          ? await authClient.signUp.email({ name, email, password })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        throw new Error(result.error.message ?? "Sign-in failed.");
      }
      window.location.assign("/");
    } catch (caught) {
      setError(errorText(caught));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {mode === "up" ? (
        <Field label="Your name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
        </Field>
      ) : null}
      <Field label="Email">
        <TextInput
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
        />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <TextInput
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          autoComplete={mode === "up" ? "new-password" : "current-password"}
        />
      </Field>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Working…" : mode === "up" ? "Create account" : "Sign in with email"}
      </Button>
      <button
        type="button"
        className="text-sm text-muted underline-offset-4 hover:underline"
        onClick={() => {
          setMode(mode === "up" ? "in" : "up");
          setError(null);
        }}
      >
        {mode === "up" ? "I already have an account" : "Create an account instead"}
      </button>
    </form>
  );
}
