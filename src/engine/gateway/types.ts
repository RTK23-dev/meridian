// The shapes the API gateway speaks. Every network call the engine makes goes through one gateway (gateway.ts), which owns
// the transport, the credentials and the authentication. Adapters receive a transport and never see fetch or a raw key
// they did not ask the gateway for.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type HttpRequest = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  /** Aborts the request after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type HttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array };

/** Sends one request. It throws only when the host cannot be reached or the request is aborted. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** A credential as the gateway holds it for one request. It is never logged and never stored by the gateway. */
export type Credential =
  | { kind: "api_key"; secret: string }
  | { kind: "oauth"; accessToken: string; expiresAt: string | null };

/** The answer of a credential source. Not connected is a normal answer, never an error and never a success. */
export type CredentialLookup = { status: "ready"; credential: Credential } | { status: "not_connected"; reason: string };

/**
 * Where credentials come from. In Meridian this is the credential resolver (meridian.ts). An OAuth source also implements
 * refresh, which the gateway calls once when a provider answers 401.
 */
export interface CredentialSource {
  get(credentialId: string, organizationId: string | null): Promise<CredentialLookup>;
  refresh?(credentialId: string, organizationId: string | null): Promise<CredentialLookup>;
}

/** How a provider wants to be authenticated. */
export type AuthSpec =
  | { kind: "api_key"; header: string; scheme: "Bearer" | null }
  /** The key travels as a query parameter (Pixabay). It is added only to URLs on the provider's own host, like a header. */
  | { kind: "api_key_query"; param: string }
  | { kind: "oauth"; header: string }
  | { kind: "none" };

export type ProviderSpec = {
  id: string;
  /** Null until the deployment sets it (for example the media functions host). A provider with no base URL is not connected. */
  baseUrl: string | null;
  auth: AuthSpec;
  /** The id the credential source knows the key by. Null when the provider needs no credential. */
  credentialId: string | null;
  defaultHeaders: Record<string, string>;
};
