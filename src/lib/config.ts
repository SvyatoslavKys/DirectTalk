import { logDiagnostic, safeErrorText } from "./diagnostics";

const TURN_ENDPOINT_TIMEOUT_MS = 9_000;
const MAX_TURN_ICE_SERVERS = 16;
const MAX_TURN_URLS_PER_SERVER = 8;
const MAX_TURN_URLS_TOTAL = 24;

export function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL?.trim();
  if (configured) return validateWebSocketUrl(configured);

  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    return `ws://${window.location.hostname}:8787`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/signal`;
}

export async function rtcConfiguration(): Promise<RTCConfiguration> {
  const stunUrl = import.meta.env.VITE_STUN_URL?.trim() || "stun:stun.cloudflare.com:3478";
  const fallback = [{ urls: stunUrl }];

  if (isLocalDevelopment()) {
    logDiagnostic("turn", "skipped-local-development");
    return createRtcConfiguration(fallback);
  }

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TURN_ENDPOINT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch("/api/turn", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeout);
    }

    if (!response.ok) {
      logDiagnostic("turn", "credentials-unavailable", { status: response.status }, "warn");
      return createRtcConfiguration(fallback);
    }

    const turnResponse = parseTurnResponse(await response.json());
    const iceServers = addFallbackIceServers(turnResponse.iceServers, fallback);
    if (!iceServers.some(hasTurnUrl)) throw new Error("TURN response does not contain a relay server");
    logDiagnostic("turn", "credentials-ready", {
      provider: turnResponse.provider,
      serverCount: iceServers.length,
      relayConfigured: true,
    });
    return createRtcConfiguration(iceServers);
  } catch (error) {
    logDiagnostic("turn", "credentials-failed", { reason: safeErrorText(error) }, "warn");
    return createRtcConfiguration(fallback);
  }
}

function createRtcConfiguration(iceServers: RTCIceServer[]): RTCConfiguration {
  return { iceServers, bundlePolicy: "max-bundle" };
}

function isLocalDevelopment(): boolean {
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

function parseTurnResponse(value: unknown): { iceServers: RTCIceServer[]; provider: string } {
  if (!value || typeof value !== "object") throw new Error("Invalid TURN response");
  const payload = value as { iceServers?: unknown; provider?: unknown };
  const rawServers = payload.iceServers;
  if (!Array.isArray(rawServers) || rawServers.length < 1 || rawServers.length > MAX_TURN_ICE_SERVERS) {
    throw new Error("Invalid TURN server list");
  }

  const seenUrls = new Set<string>();
  let urlCount = 0;
  const iceServers: RTCIceServer[] = [];
  for (const raw of rawServers) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid TURN server");
    const server = raw as Record<string, unknown>;
    const result: RTCIceServer = { urls: [] };
    if (server.username !== undefined) {
      if (typeof server.username !== "string" || server.username.length > 512) throw new Error("Invalid TURN username");
      result.username = server.username;
    }
    if (server.credential !== undefined) {
      if (typeof server.credential !== "string" || server.credential.length > 1_024) throw new Error("Invalid TURN credential");
      result.credential = server.credential;
    }
    const urls = parseIceUrls(server.urls).filter((url) => {
      const key = iceUrlDedupeKey(url, result);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
    if (!urls.length) continue;
    urlCount += urls.length;
    if (urlCount > MAX_TURN_URLS_TOTAL) throw new Error("Too many TURN URLs");
    result.urls = typeof server.urls === "string" ? urls[0] : urls;
    iceServers.push(result);
  }
  if (!iceServers.length) throw new Error("Invalid TURN server list");
  const provider =
    payload.provider === "metered" ||
    payload.provider === "cloudflare" ||
    payload.provider === "metered+cloudflare" ||
    payload.provider === "open-relay-test"
      ? payload.provider
      : "unknown";
  return { iceServers, provider };
}

function addFallbackIceServers(iceServers: RTCIceServer[], fallback: RTCIceServer[]): RTCIceServer[] {
  const configuredUrls = new Set(iceServers.flatMap((server) => iceServerUrls(server)));
  const configuredUrlCount = iceServers.reduce((count, server) => count + iceServerUrls(server).length, 0);
  if (iceServers.length >= MAX_TURN_ICE_SERVERS || configuredUrlCount >= MAX_TURN_URLS_TOTAL) return iceServers;
  const missingFallback = fallback.filter((server) =>
    iceServerUrls(server).some((url) => !configuredUrls.has(url)),
  );
  return missingFallback.length ? [...iceServers, ...missingFallback] : iceServers;
}

function iceServerUrls(server: RTCIceServer): string[] {
  return typeof server.urls === "string" ? [server.urls] : server.urls;
}

function parseIceUrls(value: unknown): string[] {
  const urls = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (urls.length > MAX_TURN_URLS_PER_SERVER) throw new Error("Too many TURN URLs");
  const safeUrls = [...new Set(urls.filter((url): url is string => {
    if (typeof url !== "string" || url.length > 1_024) return false;
    if (!/^(?:stun|turn|turns):/iu.test(url)) return false;
    return !/:(?:53)(?:\?|$)/u.test(url);
  }))];
  if (!safeUrls.length) throw new Error("TURN server has no supported URLs");
  return safeUrls;
}

function iceUrlDedupeKey(url: string, server: RTCIceServer): string {
  return /^stun:/iu.test(url)
    ? url
    : JSON.stringify([url, server.username ?? null, server.credential ?? null]);
}

function hasTurnUrl(server: RTCIceServer): boolean {
  return iceServerUrls(server).some((url) => /^(?:turn|turns):/iu.test(url));
}

function validateWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Signaling URL должен использовать ws:// или wss://");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (window.location.protocol === "https:" && url.protocol !== "wss:" && !local) {
    throw new Error("На HTTPS-странице signaling обязан использовать WSS");
  }
  return url.toString();
}
