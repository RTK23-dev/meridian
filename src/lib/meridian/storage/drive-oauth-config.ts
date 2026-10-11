/**
 * The Google endpoints and scope that Drive connection and authentication share. Kept dependency-free, so both the auth
 * resolver and the OAuth flow can import it without importing each other.
 */

/** drive.file: Google grants access only to the files Meridian creates or opens, not to the rest of the account's Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** The path, under the site origin, that Google returns the person to. It must be registered on the OAuth client. */
export const DRIVE_CALLBACK_PATH = "/api/drive/callback";
