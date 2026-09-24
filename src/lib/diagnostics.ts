import { APP_VERSION } from "./version";

export type DiagnosticLevel = "info" | "warn" | "error";

export interface DiagnosticEntry {
  id: number;
  at: string;
  level: DiagnosticLevel;
  scope: string;
  event: string;
  details?: Record<string, string | number | boolean | null>;
}

type DiagnosticDetails = Record<string, string | number | boolean | null | undefined>;
type DiagnosticListener = () => void;
type BrowserNetworkConnection = {
  effectiveType?: string;
  downlink?: number;
  saveData?: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

const STORAGE_KEY = "directtalk.diagnostics.v2";
const MAX_ENTRIES = 160;
const SAFE_DETAIL_KEYS = new Set([
  "attachments",
  "attempt",
  "availableOutgoingBitrateKbps",
  "bufferedAfterBucket",
  "bufferedAmountBucket",
  "bufferedBeforeBucket",
  "bytesReceivedBucket",
  "bytesSentBucket",
  "channelState",
  "clean",
  "closed",
  "code",
  "count",
  "currentRoundTripTimeMs",
  "delay",
  "downlink",
  "durationMs",
  "effectiveType",
  "encodedLength",
  "errorCode",
  "errorName",
  "generation",
  "hostCandidates",
  "iceError701Count",
  "iceErrorCount",
  "iceErrorRoutes",
  "iceType",
  "kind",
  "localRouteType",
  "messages",
  "nominated",
  "online",
  "origin",
  "packetsReceived",
  "packetsSent",
  "pairState",
  "persisted",
  "phase",
  "prflxCandidates",
  "protocol",
  "provider",
  "queued",
  "queuedCandidates",
  "reason",
  "recovery",
  "relayCandidates",
  "relayConfigured",
  "relayProtocol",
  "remoteRouteType",
  "role",
  "rxPackets",
  "saveData",
  "secure",
  "secureContext",
  "serverCount",
  "srflxCandidates",
  "stage",
  "state",
  "status",
  "transport",
  "trigger",
  "txPackets",
  "type",
  "urlScheme",
  "version",
  "visibility",
  "wireSizeBucket",
]);
const listeners = new Set<DiagnosticListener>();
let entries = readStoredEntries();
let nextId = (entries.at(-1)?.id ?? 0) + 1;
let initialized = false;
let started = false;

export function initializeDiagnostics(): () => void {
  if (initialized) return () => undefined;
  initialized = true;

  if (!started) {
    started = true;
    logDiagnostic("app", "started", {
      version: APP_VERSION,
      secureContext: window.isSecureContext,
      online: navigator.onLine,
      visibility: document.visibilityState,
    });
  }

  const onError = (event: ErrorEvent) => {
    logDiagnostic("browser", "uncaught-error", { reason: safeErrorText(event.error ?? event.message) }, "error");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    logDiagnostic("browser", "unhandled-rejection", { reason: safeErrorText(event.reason) }, "error");
  };
  const onOnline = () => logDiagnostic("network", "online", { online: true });
  const onOffline = () => logDiagnostic("network", "offline", { online: false }, "warn");
  const onVisibility = () => logDiagnostic("app", "visibility", { visibility: document.visibilityState });
  const onPageHide = (event: PageTransitionEvent) => logDiagnostic("app", "page-hide", { persisted: event.persisted });
  const networkConnection = getNavigatorConnection();
  const onNetworkChange = () => {
    logDiagnostic("network", "connection-change", networkConnectionDetails(networkConnection));
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  networkConnection?.addEventListener?.("change", onNetworkChange);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    networkConnection?.removeEventListener?.("change", onNetworkChange);
    initialized = false;
  };
}

export function logDiagnostic(
  scope: string,
  event: string,
  details?: DiagnosticDetails,
  level: DiagnosticLevel = "info",
): number {
  const entry: DiagnosticEntry = {
    id: nextId++,
    at: new Date().toISOString(),
    level,
    scope: safeLabel(scope),
    event: safeLabel(event),
  };
  const safeDetails = sanitizeDetails(details);
  if (safeDetails && Object.keys(safeDetails).length) entry.details = safeDetails;
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  persistEntries();
  listeners.forEach((listener) => listener());
  return entry.id;
}

export function getDiagnosticEntries(): readonly DiagnosticEntry[] {
  return entries;
}

export function subscribeDiagnostics(listener: DiagnosticListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearDiagnostics(): void {
  entries = [];
  persistEntries();
  listeners.forEach((listener) => listener());
}

export function formatDiagnosticReport(): string {
  const connection = navigatorConnection();
  const header = [
    "DirectTalk diagnostics",
    "format=2",
    `generated=${new Date().toISOString()}`,
    `app=${APP_VERSION}`,
    `origin=${diagnosticOrigin()}`,
    `path=${safeErrorText(window.location.pathname, 260)}`,
    `browser=${safeUserAgentText(navigator.userAgent, 260)}`,
    `language=${navigator.language}`,
    `online=${navigator.onLine}`,
    `visibility=${document.visibilityState}`,
    `secureContext=${window.isSecureContext}`,
    `screen=${window.screen.width}x${window.screen.height}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
    connection ? `network=${connection}` : "network=unavailable",
    "privacy=message text, files, keys, invitation secrets, SDP, ICE candidate values, IP addresses, ports and exact payload sizes are not logged",
    "",
  ];
  const lines = entries.map((entry) => {
    const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
    return `${entry.at} #${entry.id} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.event}${details}`;
  });
  return [...header, ...lines].join("\n");
}

export function safeErrorText(reason: unknown, maxLength = 180): string {
  const raw = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "Unknown error");
  return redactSensitiveText(raw, maxLength, false);
}

function safeUserAgentText(value: unknown, maxLength: number): string {
  return redactSensitiveText(String(value ?? "Unknown browser"), maxLength, true);
}

function redactSensitiveText(raw: string, maxLength: number, preserveBrowserVersions: boolean): string {
  return raw
    .replace(/\b(?:https?|wss?):\/\/\S+|\b(?:stun|stuns|turn|turns):\S+/giu, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu, (match, offset: number, input: string) =>
      preserveBrowserVersions && isBrowserProductVersion(input, offset) ? match : "[ip]")
    .replace(/\[(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]{0,45}\](?::\d{1,5})?/giu, "[ip]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/giu, "[ip]")
    .replace(/\b(?:[a-f0-9]{1,4}:){1,7}:[a-f0-9]{0,4}\b/giu, "[ip]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, maxLength);
}

function diagnosticOrigin(): string {
  try {
    const { protocol, hostname, port } = window.location;
    const ipLiteral = isIpHostname(hostname);
    const safeHostname = ipLiteral ? "[ip]" : hostname;
    return `${protocol}//${safeHostname}${port && !ipLiteral ? `:${port}` : ""}`;
  } catch {
    return "unavailable";
  }
}

function isIpHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, "");
  return value.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value);
}

function sanitizeDetails(details?: DiagnosticDetails): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || !SAFE_DETAIL_KEYS.has(key)) continue;
    result[safeLabel(key)] = typeof value === "string" ? safeErrorText(value) : value;
  }
  return result;
}

function isBrowserProductVersion(input: string, offset: number): boolean {
  const prefix = input.slice(Math.max(0, offset - 32), offset);
  return /(?:Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|OPR|Firefox|FxiOS|Version)\/$/iu.test(prefix);
}

function safeLabel(value: string): string {
  return value.replace(/[^a-z0-9._:-]/giu, "-").slice(0, 64);
}

function persistEntries(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Diagnostics must never break the application when browser storage is unavailable.
  }
}

function readStoredEntries(): DiagnosticEntry[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDiagnosticEntry).slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DiagnosticEntry>;
  return typeof entry.id === "number" && typeof entry.at === "string" &&
    (entry.level === "info" || entry.level === "warn" || entry.level === "error") &&
    typeof entry.scope === "string" && typeof entry.event === "string";
}

function navigatorConnection(): string | null {
  const connection = getNavigatorConnection();
  if (!connection) return null;
  return [
    connection.effectiveType ? `type:${connection.effectiveType}` : null,
    typeof connection.downlink === "number" ? `downlink:${connection.downlink}` : null,
    typeof connection.saveData === "boolean" ? `saveData:${connection.saveData}` : null,
  ].filter(Boolean).join(",");
}

function getNavigatorConnection(): BrowserNetworkConnection | undefined {
  return (navigator as Navigator & { connection?: BrowserNetworkConnection }).connection;
}

function networkConnectionDetails(connection?: BrowserNetworkConnection): DiagnosticDetails {
  return {
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    saveData: connection?.saveData,
  };
}
