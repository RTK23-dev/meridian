/**
 * What the Google Drive panel on the settings screen says about the connection. It is built from the deployment environment
 * by name and presence only. It never contains a secret, a key, or a token.
 *
 * Drive is the artifact store: it holds rendered media, export packages and uploaded source files. Postgres records every
 * row about them. Drive is connected by a service account key or by OAuth refresh credentials, both set in the deployment
 * environment. The Google sign-in on the Integrations screen does not connect Drive (see oauthSignInNote).
 */
import { getGoogleDriveAuthStatus } from "./google-auth.ts";

export type DriveConnectionView = {
  method: "service_account" | "oauth_refresh" | "none";
  /** "credentials_set": the deployment has Drive credentials. A check confirms that Drive accepts them. */
  state: "credentials_set" | "not_connected";
  detail: string;
  folderConfigured: boolean;
  /** Names of settings still missing. Never values. */
  missing: string[];
  /** Why the Google sign-in on the Integrations screen does not connect Drive. */
  oauthSignInNote: string;
  /** Exact setup steps. Empty once credentials are set. */
  steps: string[];
};

const SERVICE_ACCOUNT_STEPS = [
  "Open the Google Cloud project that will own Meridian's Drive access, and enable the Google Drive API for it.",
  "Create a service account (IAM and Admin, then Service accounts) and create a JSON key for it.",
  "In the deployment environment, set GOOGLE_SERVICE_ACCOUNT_KEY to the full JSON key. Keep it out of the repository.",
  "In Google Drive, create a folder for Meridian artifacts and share it with the service account's email address as Editor.",
  "In the deployment environment, set MERIDIAN_DRIVE_FOLDER_ID to that folder's ID, the last part of its URL.",
];

const OAUTH_STEPS = [
  "Or connect with OAuth. In Google Cloud Console, open APIs and Services, then Credentials, and create an OAuth client ID of type Web application for the project with the Google Drive API enabled.",
  "Use the scope https://www.googleapis.com/auth/drive. If you obtain the refresh token with the OAuth 2.0 Playground, add https://developers.google.com/oauthplayground as an authorized redirect URI of that client.",
  "In the deployment environment, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to that client, and GOOGLE_REFRESH_TOKEN to its refresh token.",
  "Set MERIDIAN_DRIVE_FOLDER_ID as above.",
];

export const OAUTH_SIGN_IN_NOTE =
  "The Google sign-in on the Integrations screen connects Google Ads. It requests the Ads scope and stores its token for Ads, so it does not connect Drive. This screen has no Drive sign-in button because the app does not yet have a Drive scope or a Drive token store.";

export function driveConnectionView(env: NodeJS.ProcessEnv = process.env): DriveConnectionView {
  const auth = getGoogleDriveAuthStatus(env);
  const folderConfigured = Boolean(env.MERIDIAN_DRIVE_FOLDER_ID?.trim());
  if (auth.configured) {
    return {
      method: auth.type,
      state: "credentials_set",
      detail: auth.detail,
      folderConfigured,
      missing: folderConfigured ? [] : ["MERIDIAN_DRIVE_FOLDER_ID"],
      oauthSignInNote: OAUTH_SIGN_IN_NOTE,
      steps: [],
    };
  }
  return {
    method: "none",
    state: "not_connected",
    detail: auth.detail,
    folderConfigured,
    missing: ["GOOGLE_SERVICE_ACCOUNT_KEY, or GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN", ...(folderConfigured ? [] : ["MERIDIAN_DRIVE_FOLDER_ID"])],
    oauthSignInNote: OAUTH_SIGN_IN_NOTE,
    steps: [...SERVICE_ACCOUNT_STEPS, ...OAUTH_STEPS],
  };
}
