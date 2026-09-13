import { createHmac } from "node:crypto";
import Redis from "ioredis";

const CLOUDFLARE_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_REQUESTS = 24;
const PROVIDER_DEADLINE_MS = 8_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;
const MIN_CREDENTIAL_TTL_SECONDS = 10 * 60;
const MAX_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;
const REDIS_PREFIX = "directtalk:turn-rate:v1";

let redis;

export default async function handler(request, response) {
  setSecurityHeaders(response);

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "method-not-allowed" });
  }
  if (!isSameOrigin(request)) return sendJson(response, 403, { error: "origin-not-allowed" });

  let providers;
  try {
    providers = configuredProviders();
  } catch {
    return sendJson(response, 503, { error: "turn-invalid-configuration" });
  }
  if (!providers.length) return sendJson(response, 503, { error: "turn-not-configured" });

  try {
    const allowed = await consumeRateLimit(request, providers[0].rateLimitSecret);
    if (!allowed) return sendJson(response, 429, { error: "rate-limit-exceeded" });

    const deadline = Date.now() + PROVIDER_DEADLINE_MS;
    for (const provider of providers) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const result = await provider.credentials(Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remaining));
        const iceServers = sanitizeIceServers(result.iceServers);
        if (!iceServers.some(hasTurnUrl)) throw new Error("TURN response has no relay server");
        return sendJson(response, 200, {
          iceServers,
          provider: provider.name,
          ...(result.ttl ? { ttl: result.ttl } : {}),
        });
      } catch {
        // Try the next configured provider without logging credentials or response bodies.
      }
    }
    return sendJson(response, 502, { error: "turn-provider-unavailable" });
  } catch {
    return sendJson(response, 503, { error: "turn-temporarily-unavailable" });
  }
}

function configuredProviders() {
  const providers = [];
  const meteredUrl = process.env.METERED_TURN_CREDENTIALS_URL?.trim();
  const meteredApiKey = process.env.METERED_TURN_API_KEY?.trim();
  if (meteredUrl || meteredApiKey) {
    if (!meteredUrl || !meteredApiKey) throw new Error("Incomplete Metered TURN configuration");
    const credentialsUrl = validateMeteredCredentialsUrl(meteredUrl);
    providers.push({
      name: "metered",
      rateLimitSecret: meteredApiKey,
      credentials: (timeout) => fetchMeteredCredentials(credentialsUrl, meteredApiKey, timeout),
    });
  }

  const cloudflareKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const cloudflareApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (cloudflareKeyId || cloudflareApiToken) {
    if (!cloudflareKeyId || !cloudflareApiToken) throw new Error("Incomplete Cloudflare TURN configuration");
    providers.push({
      name: "cloudflare",
      rateLimitSecret: cloudflareApiToken,
      credentials: (timeout) => fetchCloudflareCredentials(cloudflareKeyId, cloudflareApiToken, timeout),
    });
  }

  return providers;
}

async function fetchMeteredCredentials(credentialsUrl, apiKey, timeout) {
  const url = new URL(credentialsUrl);
  url.searchParams.set("apiKey", apiKey);
  const providerResponse = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!providerResponse.ok) throw new Error("Metered TURN unavailable");
  return { iceServers: extractIceServers(await providerResponse.json()) };
}

async function fetchCloudflareCredentials(keyId, apiToken, timeout) {
  const ttl = credentialTtlSeconds();
  const providerResponse = await fetch(
    `${CLOUDFLARE_ENDPOINT}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(timeout),
    },
  );
  if (!providerResponse.ok) throw new Error("Cloudflare TURN unavailable");
  return { iceServers: extractIceServers(await providerResponse.json()), ttl };
}

function extractIceServers(payload) {
  return Array.isArray(payload) ? payload : payload?.iceServers;
}

function validateMeteredCredentialsUrl(value) {
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/u, "");
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".metered.live") ||
    url.hostname === "metered.live" ||
    path !== "/api/v1/turn/credentials" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Metered TURN credentials URL");
  }
  url.pathname = path;
  return url.toString();
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return false;
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  if (!host) return false;
  const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return origin === `${protocol}://${host}`;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0]?.split(",")[0]?.trim() ?? "";
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

async function consumeRateLimit(request, providerSecret) {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return false;
  redis ??= createRedis(redisUrl);
  const address = firstHeaderValue(request.headers["x-forwarded-for"]) || request.socket?.remoteAddress || "unknown";
  const digest = createHmac("sha256", process.env.TURN_RATE_LIMIT_SECRET?.trim() || providerSecret)
    .update(address)
    .digest("hex")
    .slice(0, 32);
  const count = await redis.eval(
    "local value = redis.call('incr', KEYS[1]); if value == 1 then redis.call('expire', KEYS[1], ARGV[1]); end; return value",
    1,
    `${REDIS_PREFIX}:${digest}`,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  return Number(count) <= RATE_LIMIT_REQUESTS;
}

function createRedis(url) {
  const client = new Redis(url, {
    enableReadyCheck: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    lazyConnect: true,
  });
  client.on("error", () => undefined);
  return client;
}

function credentialTtlSeconds() {
  const configured = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_CREDENTIAL_TTL_SECONDS;
  return Math.max(MIN_CREDENTIAL_TTL_SECONDS, Math.min(MAX_CREDENTIAL_TTL_SECONDS, Math.trunc(configured)));
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error("Invalid ICE server list");
  return value.map((server) => {
    if (!server || typeof server !== "object") throw new Error("Invalid ICE server");
    const urls = sanitizeIceUrls(server.urls);
    const result = { urls };
    if (server.username !== undefined) {
      if (typeof server.username !== "string" || server.username.length > 512) throw new Error("Invalid TURN username");
      result.username = server.username;
    }
    if (server.credential !== undefined) {
      if (typeof server.credential !== "string" || server.credential.length > 1_024) throw new Error("Invalid TURN credential");
      result.credential = server.credential;
    }
    return result;
  });
}

function sanitizeIceUrls(value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const safe = list.filter((url) =>
    typeof url === "string" &&
    url.length <= 1_024 &&
    /^(?:stun|turn|turns):/iu.test(url) &&
    !/:(?:53)(?:\?|$)/u.test(url),
  );
  if (!safe.length) throw new Error("No supported ICE URLs");
  return typeof value === "string" ? safe[0] : safe;
}

function hasTurnUrl(server) {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return urls.some((url) => /^(?:turn|turns):/iu.test(url));
}

export { extractIceServers, sanitizeIceServers, validateMeteredCredentialsUrl };
