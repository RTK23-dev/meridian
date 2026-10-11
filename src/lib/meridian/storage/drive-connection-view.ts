/**
 * What the Google Drive panel on the settings screen says about the connection. It is built from the deployment environment
 * by name and presence only, and from whether this workspace has connected. It never contains a secret, a key, or a token.
 *
 * Drive is the artifact store: it holds rendered media, export packages and uploaded source files. Postgres records every row
 * about them. A workspace connects its own Google Drive from this panel (an admin does it). The deployment can instead supply
 * a service account key or OAuth refresh credentials in its environment. The Google sign-in on the Integrations screen does
 * not connect Drive (see OAUTH_SIGN_IN_NOTE).
 */
import { driveOauthClient } from "./drive-oauth.ts";
import { getGoogleDriveAuthStatus } from "./google-auth.ts";

export type DriveConnectionView = {
  /** "workspace": this workspace connected its own account, and that account is used for it ahead of the deployment's. */
  method: "workspace" | "service_account" | "oauth_refresh" | "none";
  /**
   * "connected": this workspace has a stored connection. "credentials_set": the deployment has Drive credentials. A check
   * confirms that Drive accepts them. "not_connected": neither.
   */
  state: "connected" | "credentials_set" | "not_connected";
  detail: string;
  folderConfigured: boolean;
  /** Names of settings still missing. Never values. */
  missing: string[];
  /** Why the Google sign-in on the Integrations screen does not connect Drive. */
  oauthSignInNote: string;
  /** Exact setup steps. Empty once a connection or credentials are set. */
  steps: string[];
  /** Whether the Connect control can be used, and the visible reason when it cannot. */
  connect: { available: boolean; reason: string };
  /** When this workspace connected Drive. Null when it has not. */
  connectedAt: string | null;
};

export type WorkspaceDriveConnection = { connected: boolean; connectedAt: string | null };

const SERVICE_ACCOUNT_STEPS = [
  "Open the Google Cloud project that will own Meridian's Drive access, and enable the Google Drive API for it.",
  "Create a service account (IAM and Admin, then Service accounts) and create a JSON key for it.",
  "In the deployment environment, set GOOGLE_SERVICE_ACCOUNT_KEY to the full JSON key. Keep it out of the repository.",
  "In Google Drive, create a folder for Meridian artifacts and share it with the service account's email address as Editor.",
  "In the deployment environment, set MERIDIAN_DRIVE_FOLDER_ID to that folder's ID, the last part of its URL.",
];

const WORKSPACE_STEPS = [
  "Or connect this workspace from this panel with Connect Google Drive. Before that, in Google Cloud Console, enable the Google Drive API for the project and create an OAuth client ID of type Web application.",
  "Add the authorized redirect URI for this site: the site's origin followed by /api/drive/callback. Google returns to that address after consent.",
  "In the deployment environment, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to that client. Meridian asks Google only for access to the files it creates (drive.file).",
];

export const OAUTH_SIGN_IN_NOTE =
  "The Google sign-in on the Integrations screen connects Google Ads. It requests the Ads scope and stores its token for Ads, so it does not connect Drive. Drive is connected from this panel.";

export function driveConnectionView(
  env: NodeJS.ProcessEnv = process.env,
  workspace: WorkspaceDriveConnection = { connected: false, connectedAt: null },
): DriveConnectionView {
  const auth = getGoogleDriveAuthStatus(env);
  const folderConfigured = Boolean(env.MERIDIAN_DRIVE_FOLDER_ID?.trim());
  const client = driveOauthClient(env);
  const connect = client.ready
    ? { available: true, reason: "" }
    : {
        available: false,
        reason: `Connecting Google Drive needs ${client.missing.join(" and ")} set in the deployment environment. Nothing is connected until both are set.`,
      };

  if (workspace.connected) {
    // The connection is stored, but it can only be used with the OAuth client. Without it, say so rather than report it working.
    return {
      method: "workspace",
      state: "connected",
      detail: client.ready
        ? "This workspace is connected to Google Drive with its own Google account. Meridian can see only the files it creates."
        : "This workspace's Google Drive connection is stored, but GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so it cannot be used. Set them, or disconnect.",
      folderConfigured,
      missing: client.ready ? [] : [...client.missing],
      oauthSignInNote: OAUTH_SIGN_IN_NOTE,
      steps: [],
      connect,
      connectedAt: workspace.connectedAt,
    };
  }

  if (auth.configured) {
    return {
      method: auth.type,
      state: "credentials_set",
      detail: auth.detail,
      folderConfigured,
      missing: folderConfigured ? [] : ["MERIDIAN_DRIVE_FOLDER_ID"],
      oauthSignInNote: OAUTH_SIGN_IN_NOTE,
      steps: [],
      connect,
      connectedAt: null,
    };
  }

  return {
    method: "none",
    state: "not_connected",
    detail: auth.detail,
    folderConfigured,
    missing: [
      "A workspace connection, or GOOGLE_SERVICE_ACCOUNT_KEY, or GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN",
      ...(folderConfigured ? [] : ["MERIDIAN_DRIVE_FOLDER_ID"]),
    ],
    oauthSignInNote: OAUTH_SIGN_IN_NOTE,
    steps: [...WORKSPACE_STEPS, ...SERVICE_ACCOUNT_STEPS],
    connect,
    connectedAt: null,
  };
}
