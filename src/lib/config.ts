export function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL?.trim();
  if (configured) return validateWebSocketUrl(configured);

  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    return `ws://${window.location.hostname}:8787`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/signal`;
}

export function rtcConfiguration(): RTCConfiguration {
  const stunUrl = import.meta.env.VITE_STUN_URL?.trim() || "stun:stun.cloudflare.com:3478";
  return {
    iceServers: [{ urls: stunUrl }],
    bundlePolicy: "max-bundle",
  };
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
