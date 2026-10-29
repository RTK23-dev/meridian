// Non-secret server settings (coding loop, T3). A flag is read through one of the accessors here, so the settings a reader depends on
// are visible in one place. Secrets are not read here: keys stay with the provider resolver (src/lib/meridian/credentials), which is
// the allowlisted reader. Each accessor reads the environment when it is called, as the readers did before, so a change is seen at once.

/** The testing runtime flag. Only the exact value "true" turns it on. Any other value, or none, leaves it off. */
export function testingRuntimeFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_TESTING_RUNTIME === "true";
}

/** Whether a proxy's forwarded headers are trusted for client keys. Only the exact value "true" trusts them. */
export function trustProxyHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_TRUST_PROXY_HEADERS === "true";
}

/** Whether synthetic telemetry may be written outside development. Only the exact value "true" allows it. */
export function syntheticTelemetryAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_SYNTHETIC_TELEMETRY === "true";
}

// Deployment settings the readers used directly. Each returns the raw value, as the reader got it before, so the reader keeps its own
// rule for blank and unset. Each reads the environment when it is called.

/** The Hypit base URL. Callers treat a blank value as not set. */
export function hypitBaseUrlSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HYPIT_BASE_URL;
}

/** The Cyclone gateway URL. */
export function cycloneGatewayUrlSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CYCLONE_GATEWAY_URL;
}

/** The ffmpeg binary, when the deployment names one. */
export function ffmpegPathSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FFMPEG_PATH;
}

/** The ffprobe binary, when the deployment names one. */
export function ffprobePathSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FFPROBE_PATH;
}

/** The folder the embedding model's cache lives in. */
export function hfHomeSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HF_HOME;
}

/** The WhisperX model name for transcription. Callers default a blank value. */
export function whisperxModelSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.WHISPERX_MODEL;
}

/** The perception model name. Callers default a blank value. */
export function perceptionModelSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PERCEPTION_MODEL;
}

/** The Higgsfield model name. */
export function higgsfieldModelSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HIGGSFIELD_MODEL;
}

/** The email delivery API URL. */
export function emailApiUrlSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EMAIL_API_URL;
}

/** The external embedding service URL. */
export function externalSemanticUrlSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EXTERNAL_SEMANTIC_URL;
}

/** The external embedding model name. */
export function externalSemanticModelSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EXTERNAL_SEMANTIC_MODEL;
}

/** The external embedding dimensions, as text. The reader turns it into a number. */
export function externalSemanticDimensionsSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EXTERNAL_SEMANTIC_DIMENSIONS;
}

/** The deployment's OpenRouter Decisions model. */
export function openRouterDecisionsModelSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENROUTER_DECISIONS_MODEL;
}

/** The hosts an artifact may be fetched from, as the deployment lists them. */
export function artifactHostAllowlistSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MERIDIAN_ARTIFACT_HOST_ALLOWLIST;
}
