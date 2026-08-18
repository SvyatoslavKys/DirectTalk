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

const STORAGE_KEY = "directtalk.diagnostics.v1";
const MAX_ENTRIES = 160;
const listeners = new Set<DiagnosticListener>();
let entries = readStoredEntries();
let nextId = (entries.at(-1)?.id ?? 0) + 1;
let initialized = false;

export function initializeDiagnostics(): () => void {
  if (initialized) return () => undefined;
  initialized = true;

  logDiagnostic("app", "started", {
    version: APP_VERSION,
    secureContext: window.isSecureContext,
    online: navigator.onLine,
    visibility: document.visibilityState,
  });

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

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
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
  logDiagnostic("diagnostics", "cleared");
}

export function formatDiagnosticReport(): string {
  const connection = navigatorConnection();
  const header = [
    "DirectTalk diagnostics",
    "format=1",
    `generated=${new Date().toISOString()}`,
    `app=${APP_VERSION}`,
    `origin=${window.location.origin}`,
    `path=${window.location.pathname}`,
    `browser=${safeErrorText(navigator.userAgent, 260)}`,
    `language=${navigator.language}`,
    `online=${navigator.onLine}`,
    `visibility=${document.visibilityState}`,
    `secureContext=${window.isSecureContext}`,
    `screen=${window.screen.width}x${window.screen.height}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
    connection ? `network=${connection}` : "network=unavailable",
    "privacy=message text, files, keys, invitation secrets, SDP, ICE candidate values and IP addresses are not logged; only ICE route type is recorded",
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
  return raw
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ip]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, maxLength);
}

function sanitizeDetails(details?: DiagnosticDetails): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || /secret|token|key|identity|fingerprint|room|invite|sdp|candidate|message|text|file|photo|payload/iu.test(key)) continue;
    result[safeLabel(key)] = typeof value === "string" ? safeErrorText(value) : value;
  }
  return result;
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
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean };
  }).connection;
  if (!connection) return null;
  return [
    connection.effectiveType ? `type:${connection.effectiveType}` : null,
    typeof connection.downlink === "number" ? `downlink:${connection.downlink}` : null,
    typeof connection.saveData === "boolean" ? `saveData:${connection.saveData}` : null,
  ].filter(Boolean).join(",");
}
