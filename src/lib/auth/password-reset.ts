/**
 * Password reset by email: the message, the answers the screen gives, and the one decision that matters, whether email can be sent at all.
 * Pure (no auth, database or network import beyond the email provider type), so it is tested on fixtures. `server.ts` wires it to Better Auth.
 */
import { emailApiKey } from "../meridian/credentials/secret-settings.ts";
import { emailApiUrlSetting } from "../meridian/config/server-settings.ts";

/** How long a reset link works, in seconds. Better Auth deletes the token when it is used, so a link works once. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

export const PASSWORD_RESET_NOT_SET_UP =
  "Password reset by email is not set up on this server, so no email can be sent. Ask whoever runs this server to set it up, or to reset your password for you.";

/** The same answer for every address, whether or not it has an account. */
export const PASSWORD_RESET_REQUESTED = "If that email has an account, a reset link is on its way.";

export type PasswordResetAnswer = { status: "requested" | "not_set_up"; message: string };

/** True when an email service URL and key are both saved. Nothing is sent otherwise. */
export function passwordResetEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(emailApiUrlSetting(env)?.trim() && emailApiKey(env)?.trim());
}

export function resetPasswordLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

export function resetPasswordEmail(input: { email: string; token: string; origin: string }): { to: string; subject: string; text: string } {
  const minutes = Math.round(RESET_TOKEN_TTL_SECONDS / 60);
  const expires = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;
  return {
    to: input.email,
    subject: "Reset your Meridian password",
    text:
      `Someone asked to reset the password for this Meridian account. Open this one-time link to choose a new password: ` +
      `${resetPasswordLink(input.origin, input.token)} ` +
      `It works once and expires in ${expires}. If you did not ask for this, ignore this email and your password stays as it is.`,
  };
}

/**
 * Answers a reset request. When email is not configured it says so and calls nothing. Otherwise it asks for the reset and gives the same
 * answer whatever the address, so the screen never reveals whether an account exists.
 */
export async function answerResetRequest(input: {
  email: string;
  configured: boolean;
  requestReset: (email: string) => Promise<unknown>;
}): Promise<PasswordResetAnswer> {
  if (!input.configured) return { status: "not_set_up", message: PASSWORD_RESET_NOT_SET_UP };
  // A failure here must not change the answer: a different reply for some addresses would reveal which ones have an account.
  await input.requestReset(input.email).catch(() => undefined);
  return { status: "requested", message: PASSWORD_RESET_REQUESTED };
}
