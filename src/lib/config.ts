import { logDiagnostic, safeErrorText } from "./diagnostics";

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
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
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
    const { iceServers } = turnResponse;
    if (!iceServers.some(hasTurnUrl)) throw new Error("TURN response does not contain a relay server");
    logDiagnostic("turn", "credentials-ready", {
      provider: turnResponse.provider,
      serverCount: iceServers.length,
      relayEnabled: true,
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
  if (!Array.isArray(rawServers) || rawServers.length < 1 || rawServers.length > 12) {
    throw new Error("Invalid TURN server list");
  }

  const iceServers = rawServers.map((raw): RTCIceServer => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid TURN server");
    const server = raw as Record<string, unknown>;
    const urls = parseIceUrls(server.urls);
    const result: RTCIceServer = { urls };
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
  const provider = payload.provider === "metered" || payload.provider === "cloudflare" ? payload.provider : "unknown";
  return { iceServers, provider };
}

function parseIceUrls(value: unknown): string | string[] {
  const urls = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const safeUrls = urls.filter((url): url is string => {
    if (typeof url !== "string" || url.length > 1_024) return false;
    if (!/^(?:stun|turn|turns):/iu.test(url)) return false;
    return !/:(?:53)(?:\?|$)/u.test(url);
  });
  if (!safeUrls.length) throw new Error("TURN server has no supported URLs");
  return typeof value === "string" ? safeUrls[0] : safeUrls;
}

function hasTurnUrl(server: RTCIceServer): boolean {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return urls.some((url) => /^(?:turn|turns):/iu.test(url));
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
