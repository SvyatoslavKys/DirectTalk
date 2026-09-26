import { base64UrlDecode } from "./encoding";
import { parseInvitation, type Invitation } from "./invite";
import type { PeerRole } from "./protocol";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ResumableSession {
  format: 1;
  invitation: Invitation;
  role: PeerRole;
  displayName: string;
  expectedPeerIdentity?: string;
  savedAt: number;
}

export const RESUMABLE_SESSION_KEY = "directtalk.active-session.v1";
export const RESUMABLE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

export function readResumableSession(
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now(),
): ResumableSession | null {
  try {
    const raw = storage?.getItem(RESUMABLE_SESSION_KEY);
    if (!raw) return null;
    const parsed = parseResumableSession(JSON.parse(raw), now);
    if (!parsed) storage?.removeItem(RESUMABLE_SESSION_KEY);
    return parsed;
  } catch {
    try {
      storage?.removeItem(RESUMABLE_SESSION_KEY);
    } catch {
      // Session recovery is optional.
    }
    return null;
  }
}

export function writeResumableSession(
  session: Omit<ResumableSession, "format" | "savedAt">,
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now(),
): void {
  try {
    storage?.setItem(RESUMABLE_SESSION_KEY, JSON.stringify({
      format: 1,
      ...session,
      savedAt: now,
    } satisfies ResumableSession));
  } catch {
    // A live conversation still works when sessionStorage is unavailable.
  }
}

export function updateResumablePeerIdentity(
  expectedPeerIdentity: string,
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now(),
): void {
  const current = readResumableSession(storage, now);
  if (!current) return;
  writeResumableSession({
    invitation: current.invitation,
    role: current.role,
    displayName: current.displayName,
    expectedPeerIdentity,
  }, storage, now);
}

export function clearResumableSession(storage: StorageLike | undefined = browserSessionStorage()): void {
  try {
    storage?.removeItem(RESUMABLE_SESSION_KEY);
  } catch {
    // Session recovery is optional.
  }
}

function parseResumableSession(value: unknown, now: number): ResumableSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.format !== 1 ||
    (record.role !== "creator" && record.role !== "joiner") ||
    typeof record.displayName !== "string" ||
    record.displayName.length < 1 ||
    record.displayName.length > 40 ||
    record.displayName !== record.displayName.trim().normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(record.displayName) ||
    typeof record.savedAt !== "number" ||
    !Number.isSafeInteger(record.savedAt) ||
    record.savedAt > now + 60_000 ||
    now - record.savedAt > RESUMABLE_SESSION_MAX_AGE_MS
  ) {
    return null;
  }

  let invitation: Invitation;
  try {
    invitation = parseInvitation(record.invitation);
  } catch {
    return null;
  }

  if (record.expectedPeerIdentity !== undefined) {
    if (typeof record.expectedPeerIdentity !== "string") return null;
    try {
      if (base64UrlDecode(record.expectedPeerIdentity).byteLength !== 65) return null;
    } catch {
      return null;
    }
  }

  return {
    format: 1,
    invitation,
    role: record.role,
    displayName: record.displayName,
    ...(typeof record.expectedPeerIdentity === "string"
      ? { expectedPeerIdentity: record.expectedPeerIdentity }
      : {}),
    savedAt: record.savedAt,
  };
}

function browserSessionStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
