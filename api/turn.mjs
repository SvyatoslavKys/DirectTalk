import { createHmac } from "node:crypto";
import Redis from "ioredis";

const CLOUDFLARE_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_REQUESTS = 24;
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

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !apiToken) return sendJson(response, 503, { error: "turn-not-configured" });

  try {
    const allowed = await consumeRateLimit(request, apiToken);
    if (!allowed) return sendJson(response, 429, { error: "rate-limit-exceeded" });

    const ttl = credentialTtlSeconds();
    const cloudflareResponse = await fetch(
      `${CLOUDFLARE_ENDPOINT}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!cloudflareResponse.ok) return sendJson(response, 502, { error: "turn-provider-unavailable" });
    const iceServers = sanitizeIceServers((await cloudflareResponse.json()).iceServers);
    if (!iceServers.some(hasTurnUrl)) return sendJson(response, 502, { error: "turn-provider-invalid-response" });
    return sendJson(response, 200, { iceServers, ttl });
  } catch {
    return sendJson(response, 503, { error: "turn-temporarily-unavailable" });
  }
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

async function consumeRateLimit(request, apiToken) {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return false;
  redis ??= createRedis(redisUrl);
  const address = firstHeaderValue(request.headers["x-forwarded-for"]) || request.socket?.remoteAddress || "unknown";
  const digest = createHmac("sha256", process.env.TURN_RATE_LIMIT_SECRET?.trim() || apiToken)
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
