import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { answerResetRequest, passwordResetEmailConfigured } from "./password-reset";

/**
 * The form behind "Forgot your password?". Public by design (the caller is signed out). Without an email service it answers that reset by
 * email is not set up and sends nothing; with one it gives the same answer for known and unknown addresses.
 */
export const requestPasswordResetEmail = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ email: z.email().max(200) }).parse(input))
  .handler(async ({ data }) => {
    return answerResetRequest({
      email: data.email,
      configured: passwordResetEmailConfigured(),
      requestReset: async (email) => {
        const { auth } = await import("./server");
        await auth.api.requestPasswordReset({ body: { email } });
      },
    });
  });
