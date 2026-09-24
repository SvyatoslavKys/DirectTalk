import { createHmac } from "node:crypto";
import Redis from "ioredis";

const CLOUDFLARE_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_REQUESTS = 24;
const PROVIDER_REQUEST_TIMEOUT_MS = 4_000;
const MAX_ICE_SERVERS_PER_PROVIDER = 8;
const MAX_ICE_URLS_PER_SERVER = 8;
const MAX_ICE_URLS_PER_PROVIDER = 12;
const MAX_COMBINED_ICE_SERVERS = 16;
const MAX_COMBINED_ICE_URLS = 24;
const OPEN_RELAY_STATIC_AUTH_HOST = "staticauth.openrelay.metered.ca";
const OPEN_RELAY_STATIC_AUTH_SECRET = "openrelayprojectsecret";
const OPEN_RELAY_TEST_TTL_SECONDS = 60 * 60;
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

    const providerResponse = await resolveProviderCredentials(providers);
    if (!providerResponse) return sendJson(response, 502, { error: "turn-provider-unavailable" });
    return sendJson(response, 200, providerResponse);
  } catch {
    return sendJson(response, 503, { error: "turn-temporarily-unavailable" });
  }
}

async function resolveProviderCredentials(providers, timeout = PROVIDER_REQUEST_TIMEOUT_MS) {
  const results = await Promise.all(providers.map(async (provider) => {
    try {
      const result = await provider.credentials(timeout);
      const iceServers = sanitizeIceServers(result.iceServers);
      if (!iceServers.some(hasTurnUrl)) return null;
      return {
        name: provider.name,
        iceServers,
        ttl: validCredentialTtl(result.ttl),
      };
    } catch {
      // Provider errors and response bodies can contain secrets, so do not log them.
      return null;
    }
  }));
  const successful = results.filter(Boolean);
  if (!successful.length) return null;

  const ttl = successful.length === 1 ? successful[0].ttl : undefined;
  return {
    iceServers: combineIceServers(successful.flatMap((result) => result.iceServers)),
    provider: successful.map((result) => result.name).join("+"),
    ...(ttl ? { ttl } : {}),
  };
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

  if (!providers.length) {
    providers.push({
      name: "open-relay-test",
      rateLimitSecret:
        process.env.TURN_RATE_LIMIT_SECRET?.trim() ||
        process.env.REDIS_URL?.trim() ||
        OPEN_RELAY_STATIC_AUTH_SECRET,
      credentials: () => createOpenRelayTestCredentials(),
    });
  }

  return providers;
}

function createOpenRelayTestCredentials(nowSeconds = Math.floor(Date.now() / 1_000)) {
  const expiresAt = nowSeconds + OPEN_RELAY_TEST_TTL_SECONDS;
  const username = String(expiresAt);
  const credential = createHmac("sha1", OPEN_RELAY_STATIC_AUTH_SECRET).update(username).digest("base64");
  return {
    ttl: OPEN_RELAY_TEST_TTL_SECONDS,
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      {
        urls: [
          `turn:${OPEN_RELAY_STATIC_AUTH_HOST}:80?transport=udp`,
          `turn:${OPEN_RELAY_STATIC_AUTH_HOST}:80?transport=tcp`,
          `turn:${OPEN_RELAY_STATIC_AUTH_HOST}:443?transport=tcp`,
          `turns:${OPEN_RELAY_STATIC_AUTH_HOST}:443?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  };
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

function validCredentialTtl(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ICE_SERVERS_PER_PROVIDER) {
    throw new Error("Invalid ICE server list");
  }
  const seenUrls = new Set();
  let urlCount = 0;
  const iceServers = [];
  for (const server of value) {
    if (!server || typeof server !== "object") throw new Error("Invalid ICE server");
    const credentials = {};
    if (server.username !== undefined) {
      if (typeof server.username !== "string" || server.username.length > 512) throw new Error("Invalid TURN username");
      credentials.username = server.username;
    }
    if (server.credential !== undefined) {
      if (typeof server.credential !== "string" || server.credential.length > 1_024) throw new Error("Invalid TURN credential");
      credentials.credential = server.credential;
    }
    const urls = sanitizeIceUrls(server.urls).filter((url) => {
      const key = iceUrlDedupeKey(url, credentials);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
    if (!urls.length) continue;
    urlCount += urls.length;
    if (urlCount > MAX_ICE_URLS_PER_PROVIDER) throw new Error("Too many ICE URLs");
    iceServers.push({ urls: typeof server.urls === "string" ? urls[0] : urls, ...credentials });
  }
  if (!iceServers.length) throw new Error("Invalid ICE server list");
  return iceServers;
}

function sanitizeIceUrls(value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (list.length > MAX_ICE_URLS_PER_SERVER) throw new Error("Too many ICE URLs");
  const safe = [...new Set(list.filter((url) =>
    typeof url === "string" &&
      url.length <= 1_024 &&
      /^(?:stun|turn|turns):/iu.test(url) &&
      !/:(?:53)(?:\?|$)/u.test(url),
  ))];
  if (!safe.length) throw new Error("No supported ICE URLs");
  return safe;
}

function combineIceServers(iceServers) {
  if (iceServers.length > MAX_COMBINED_ICE_SERVERS) throw new Error("Too many combined ICE servers");
  const seenUrls = new Set();
  const combined = [];
  let urlCount = 0;
  for (const server of iceServers) {
    const urls = (typeof server.urls === "string" ? [server.urls] : server.urls).filter((url) => {
      const key = iceUrlDedupeKey(url, server);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
    if (!urls.length) continue;
    urlCount += urls.length;
    if (urlCount > MAX_COMBINED_ICE_URLS) throw new Error("Too many combined ICE URLs");
    combined.push({ ...server, urls: typeof server.urls === "string" ? urls[0] : urls });
  }
  if (!combined.length) throw new Error("No combined ICE servers");
  return combined;
}

function iceUrlDedupeKey(url, server) {
  return /^stun:/iu.test(url)
    ? url
    : JSON.stringify([url, server.username ?? null, server.credential ?? null]);
}

function hasTurnUrl(server) {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return urls.some((url) => /^(?:turn|turns):/iu.test(url));
}

export {
  configuredProviders,
  createOpenRelayTestCredentials,
  extractIceServers,
  resolveProviderCredentials,
  sanitizeIceServers,
  validateMeteredCredentialsUrl,
};
