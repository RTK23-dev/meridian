/**
 * Pure form rules for the account and workspace forms: inline validation schemas and the mapping from raw server text to
 * a plain sentence. The raw text is kept for the Details disclosure, so nothing is lost when the message is simplified.
 */
import { z } from "zod";

export const emailField = z.string()
  .trim()
  .min(1, "Enter your email address.")
  .pipe(z.email("Enter an email address like name@example.com."));

export const newPasswordField = z.string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use 128 characters or fewer.");

/** Sign-in accepts any stored password length, so an account made before a rule change can still sign in. */
export const signInSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Enter your password."),
});

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80, "Use 80 characters or fewer."),
  email: emailField,
  password: newPasswordField,
});

export type SignInValues = z.input<typeof signInSchema>;
export type SignUpValues = z.input<typeof signUpSchema>;

export type ErrorContext = "sign-in" | "sign-up" | "invite" | "workspace" | "brand" | "settings";

export type AuthErrorLike = { code?: string; status?: number; message?: string };

const BAD_CREDENTIALS = "That email and password do not match an account.";
const EMAIL_IN_USE = "An account already uses this email. Sign in instead.";
const PASSWORD_SHORT = "Use at least 8 characters.";
const PASSWORD_LONG = "Use 128 characters or fewer.";
const EMAIL_FORMAT = "Enter an email address like name@example.com.";
const UNVERIFIED = "Confirm your email address first. Check your inbox for the link.";
const UNREACHABLE = "Meridian could not be reached. Check your connection and try again.";
const RATE_LIMITED = "Too many attempts. Wait a minute, then try again.";
const SESSION_ENDED = "Your session has ended. Sign in again.";
const PERMISSION = "Your role does not allow this change. Ask an admin.";
const INVITE_INVALID = "This invitation is no longer valid. Ask for a new one.";
const SERVER_FAILURE = "Meridian could not complete this. Try again shortly.";
const GENERIC = "Something went wrong. Try again. The details show what the server reported.";

/** Auth failures by the code Better Auth returns. Anything not listed falls through to the text rules below. */
const AUTH_CODES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: BAD_CREDENTIALS,
  USER_ALREADY_EXISTS: EMAIL_IN_USE,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: EMAIL_IN_USE,
  PASSWORD_TOO_SHORT: PASSWORD_SHORT,
  PASSWORD_TOO_LONG: PASSWORD_LONG,
  INVALID_EMAIL: EMAIL_FORMAT,
  EMAIL_NOT_VERIFIED: UNVERIFIED,
};

/** Text that should never reach a person as-is: database, network and stack fragments. */
const INTERNAL_TEXT = /\b(select|insert|update|relation|column|syntax|ECONN|ENOTFOUND|ETIMEDOUT|stack|TypeError|undefined|null)\b|\bat\s+\S+\(/i;

export function plainAuthError(error: AuthErrorLike, context: ErrorContext = "sign-in"): string {
  if (error.code && AUTH_CODES[error.code]) return AUTH_CODES[error.code];
  if (error.status === 429) return RATE_LIMITED;
  if (error.status === 401) return SESSION_ENDED;
  if (error.status && error.status >= 500) return SERVER_FAILURE;
  return plainServerError(error.message ?? "", context);
}

/** Maps a raw server message to plain words. Known failures get a fixed sentence. A plain sentence from our own validation passes through. */
export function plainServerError(raw: string, context: ErrorContext = "settings"): string {
  const text = raw.trim();
  if (!text) return GENERIC;
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(text)) return UNREACHABLE;
  if (/too many|rate limit/i.test(text)) return RATE_LIMITED;
  if (/invalid email or password|invalid_email_or_password|invalid credentials/i.test(text)) return BAD_CREDENTIALS;
  if (/already exists|already uses this email/i.test(text) && context === "sign-up") return EMAIL_IN_USE;
  if (/invitation/i.test(text) && /(expired|invalid|not found|already|no longer|used)/i.test(text)) return INVITE_INVALID;
  if (/do not have permission|not allowed|forbidden|only an admin|requires? (an? )?(admin|owner|member)/i.test(text)) return PERMISSION;
  if (/unauthori[sz]ed|not signed in|sign in again|session/i.test(text)) return SESSION_ENDED;
  if (text.length <= 160 && /[.!?]$/.test(text) && !INTERNAL_TEXT.test(text)) return text;
  return GENERIC;
}

/** True when the plain message adds nothing over the raw text, so the Details disclosure can be left out. */
export function needsDetails(plain: string, raw: string): boolean {
  return raw.trim() !== "" && raw.trim() !== plain.trim();
}
