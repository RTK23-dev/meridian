// The API gateway: the single place that decides where a call goes (config/routes.ts), which credential it carries and how
// it is authenticated. OpenRouter is the default platform. Moving a capability to another model or provider, or a provider
// from an API key to OAuth, is a configuration change here and in the route table; callers do not change.
//
// Fail closed: a provider with no base URL or no usable credential is not connected, and nothing is sent. Credentials are
// attached only to requests for the provider's own host, so a key can never follow a URL that came back from a provider.

import { EngineError } from "../contracts/errors.ts";
import { routes as defaultRoutes, type Capability, type RouteTable } from "../config/routes.ts";
import type { PriceKey } from "../config/prices.ts";
import { DEFAULT_PROVIDERS, isProviderId, type ProviderId, type ProviderRegistry } from "./providers.ts";
import type { Credential, CredentialLookup, CredentialSource, HttpMethod, HttpRequest, HttpResponse, HttpTransport, ProviderSpec } from "./types.ts";

export type GatewayOptions = {
  transport: HttpTransport;
  credentials: CredentialSource;
  /** Per-deployment changes to a provider, for example the media functions' base URL. */
  providers?: Partial<Record<ProviderId, Partial<Omit<ProviderSpec, "id">>>>;
  routes?: RouteTable;
};

export type ResolvedRoute = {
  capability: Capability;
  provider: ProviderSpec;
  model: string;
  priceKey: PriceKey | null;
  verified: boolean;
};

export type GatewayCall = {
  provider: string;
  /** The workspace the call is for. Null only for deployment-wide work. */
  organizationId: string | null;
  method: HttpMethod;
  /** Relative to the provider's base URL, starting with "/". */
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type GatewayResult = { status: "not_connected"; reason: string } | { status: "ok"; response: HttpResponse };

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const lower = name.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== lower));
}

function authHeaders(spec: ProviderSpec, credential: Credential): Record<string, string> {
  if (spec.auth.kind === "none" || spec.auth.kind === "api_key_query") return {};
  const token = credential.kind === "api_key" ? credential.secret : credential.accessToken;
  if (spec.auth.kind === "api_key") {
    return { [spec.auth.header]: spec.auth.scheme === null ? token : `${spec.auth.scheme} ${token}` };
  }
  return { [spec.auth.header]: `Bearer ${token}` };
}

/** The URL with the key as a query parameter, replacing any value the caller put there. */
function withQueryKey(url: string, param: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(param, token);
  return parsed.toString();
}

function onHost(baseUrl: string, url: string): boolean {
  return url === baseUrl || url.startsWith(`${baseUrl}/`) || url.startsWith(`${baseUrl}?`);
}

export class Gateway {
  private readonly transport: HttpTransport;
  private readonly credentials: CredentialSource;
  private readonly registry: ProviderRegistry;
  private readonly table: RouteTable;

  constructor(options: GatewayOptions) {
    this.transport = options.transport;
    this.credentials = options.credentials;
    this.table = options.routes ?? defaultRoutes.table;
    const registry = { ...DEFAULT_PROVIDERS };
    for (const [id, change] of Object.entries(options.providers ?? {})) {
      if (!isProviderId(id)) throw new EngineError("config", `unknown provider ${id} in the gateway options`);
      registry[id] = { ...registry[id], ...change, id };
    }
    for (const spec of Object.values(registry)) {
      if (spec.baseUrl !== null) spec.baseUrl = spec.baseUrl.replace(/\/+$/, "");
    }
    this.registry = registry;
  }

  provider(id: string): ProviderSpec {
    if (!isProviderId(id)) throw new EngineError("config", `unknown provider ${id}`);
    return this.registry[id];
  }

  /** Every target of a capability that has a model, in priority order. */
  routes(capability: Capability): ResolvedRoute[] {
    const route = this.table[capability];
    if (!route) throw new EngineError("config", `no route for capability ${capability}`);
    return route.targets
      .filter((target) => target.model !== null)
      .map((target) => ({
        capability,
        provider: this.provider(target.provider),
        model: target.model as string,
        priceKey: target.priceKey,
        verified: target.verified,
      }));
  }

  /** The providers of a capability's targets, whether or not a target names a model: the live catalog names the model, the provider stays. */
  providersOf(capability: Capability): string[] {
    const route = this.table[capability];
    if (!route) throw new EngineError("config", `no route for capability ${capability}`);
    return [...new Set(route.targets.map((target) => target.provider))];
  }

  /**
   * The route of a capability: its first target. A first target with no model refuses the capability rather than falling
   * back silently, because the estimate was priced on that first target (prices.routeFor).
   */
  route(capability: Capability): ResolvedRoute {
    const route = this.table[capability];
    if (!route) throw new EngineError("config", `no route for capability ${capability}`);
    const first = route.targets[0];
    if (!first || first.model === null) {
      const note = route.note ? ` ${route.note}` : "";
      throw new EngineError("config", `capability ${capability} has no model routed yet; no call is made.${note}`);
    }
    return { capability, provider: this.provider(first.provider), model: first.model, priceKey: first.priceKey, verified: first.verified };
  }

  /**
   * The route of a capability with a model the caller chose from the live catalog (Bible 10.5). The table names no model for
   * these capabilities, so the choice has to be passed in. The id's shape is checked here; whether the id is in the catalog is
   * the caller's check (the orchestrator's validation, or the model chooser's). A chosen route has no price key: its cost is
   * estimated from the catalog entry it was chosen from.
   */
  chosen(capability: Capability, modelId: string): ResolvedRoute {
    const route = this.table[capability];
    if (!route) throw new EngineError("config", `no route for capability ${capability}`);
    const first = route.targets[0];
    if (!first) throw new EngineError("config", `capability ${capability} has no provider target`);
    if (!/^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(modelId)) {
      throw new EngineError("config", `capability ${capability}: the chosen model id is not a vendor/model id; no call is made`);
    }
    return { capability, provider: this.provider(first.provider), model: modelId, priceKey: null, verified: false };
  }

  private async lookup(spec: ProviderSpec, organizationId: string | null, refresh: boolean): Promise<CredentialLookup | null> {
    if (spec.auth.kind === "none" || spec.credentialId === null) return null;
    if (refresh) {
      if (!this.credentials.refresh) return { status: "not_connected", reason: `${spec.id} cannot refresh its credential` };
      return this.credentials.refresh(spec.credentialId, organizationId);
    }
    return this.credentials.get(spec.credentialId, organizationId);
  }

  private async send(spec: ProviderSpec, organizationId: string | null, request: HttpRequest): Promise<GatewayResult> {
    if (spec.baseUrl === null) return { status: "not_connected", reason: `${spec.id} has no base URL set on this deployment` };
    const authenticated = onHost(spec.baseUrl, request.url);
    const attempt = async (refresh: boolean): Promise<GatewayResult> => {
      let headers = authenticated ? { ...spec.defaultHeaders, ...request.headers } : { ...request.headers };
      let url = request.url;
      if (authenticated) {
        const found = await this.lookup(spec, organizationId, refresh);
        if (found?.status === "not_connected") return { status: "not_connected", reason: found.reason };
        if (found?.status === "ready") {
          if (spec.auth.kind === "api_key_query") {
            const token = found.credential.kind === "api_key" ? found.credential.secret : found.credential.accessToken;
            url = withQueryKey(url, spec.auth.param, token);
          }
          for (const [name, value] of Object.entries(authHeaders(spec, found.credential))) {
            headers = { ...withoutHeader(headers, name), [name]: value };
          }
        }
      }
      return { status: "ok", response: await this.transport({ ...request, url, headers }) };
    };
    const first = await attempt(false);
    // An OAuth access token can expire between the lookup and the call. Refresh once, then report what the provider said.
    if (first.status === "ok" && first.response.status === 401 && authenticated && spec.auth.kind === "oauth") {
      return attempt(true);
    }
    return first;
  }

  /** One request to a provider, authenticated by the gateway. */
  async call(input: GatewayCall): Promise<GatewayResult> {
    const spec = this.provider(input.provider);
    if (!input.path.startsWith("/")) throw new EngineError("invalid_input", `gateway path ${input.path} must start with "/"`);
    if (spec.baseUrl === null) return { status: "not_connected", reason: `${spec.id} has no base URL set on this deployment` };
    return this.send(spec, input.organizationId, {
      method: input.method,
      url: `${spec.baseUrl}${input.path}`,
      headers: input.headers ?? {},
      body: input.body,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  /**
   * A transport for an adapter that builds its own URLs (the render adapter, the media functions). Requests to the provider's
   * host are authenticated; requests elsewhere (a signed upload or download URL) go out with the adapter's headers only.
   * A provider that is not connected throws a config error, so the adapter sends nothing.
   */
  transportFor(providerId: string, organizationId: string | null): HttpTransport {
    const spec = this.provider(providerId);
    return async (request) => {
      const result = await this.send(spec, organizationId, request);
      if (result.status === "not_connected") {
        throw new EngineError("config", `${spec.id} is not connected: ${result.reason}`);
      }
      return result.response;
    };
  }

  /** The provider's base URL, or a config error when the deployment has not set it. */
  baseUrlFor(providerId: string): string {
    const spec = this.provider(providerId);
    if (spec.baseUrl === null) throw new EngineError("config", `${spec.id} has no base URL set on this deployment`);
    return spec.baseUrl;
  }

  /**
   * The key itself, for an adapter whose contract takes a credential function (render/hyperframesCloud.ts). Null when the
   * provider is not connected. Prefer transportFor, which never hands the key out.
   */
  secretFor(providerId: string, organizationId: string | null): () => Promise<string | null> {
    const spec = this.provider(providerId);
    return async () => {
      const found = await this.lookup(spec, organizationId, false);
      if (!found || found.status !== "ready") return null;
      return found.credential.kind === "api_key" ? found.credential.secret : found.credential.accessToken;
    };
  }

  /** Whether a provider can be called for a workspace, with the reason when it cannot. Sends nothing. */
  async connection(providerId: string, organizationId: string | null): Promise<{ connected: boolean; reason: string | null }> {
    const spec = this.provider(providerId);
    if (spec.baseUrl === null) return { connected: false, reason: `${spec.id} has no base URL set on this deployment` };
    const found = await this.lookup(spec, organizationId, false);
    if (found?.status === "not_connected") return { connected: false, reason: found.reason };
    return { connected: true, reason: null };
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
