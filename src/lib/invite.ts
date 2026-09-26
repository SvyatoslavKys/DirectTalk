import { base64UrlDecode, base64UrlEncode, randomBytes, utf8, fromUtf8 } from "./encoding";
import { PROTOCOL_VERSION, type IdentityKeys } from "./protocol";
import { logDiagnostic } from "./diagnostics";

const CANONICAL_VERCEL_URL = "https://direct-talk.vercel.app/";

export interface Invitation {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  secret: string;
  creatorIdentity: string;
}

export function createInvitation(identity: IdentityKeys): Invitation {
  return {
    version: PROTOCOL_VERSION,
    roomId: base64UrlEncode(randomBytes(16)),
    secret: base64UrlEncode(randomBytes(32)),
    creatorIdentity: identity.publicKeyRaw,
  };
}

export function invitationUrl(invitation: Invitation): string {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim();
  const useCanonicalVercelUrl = window.location.hostname.endsWith(".vercel.app");
  const url = new URL(configuredUrl || (useCanonicalVercelUrl ? CANONICAL_VERCEL_URL : window.location.href));
  url.pathname = url.pathname || "/";
  url.search = "";
  url.hash = `invite=${base64UrlEncode(utf8(JSON.stringify(invitation)))}`;
  logDiagnostic("invite", "created", { origin: url.origin, encodedLength: url.hash.length });
  return url.toString();
}

export function readInvitationFromLocation(): Invitation | null {
  const match = /^#invite=([A-Za-z0-9_-]+)$/u.exec(window.location.hash);
  if (!match || match[1].length > 2_048) {
    if (window.location.hash.startsWith("#invite=")) {
      logDiagnostic("invite", "rejected-format", { encodedLength: window.location.hash.length }, "warn");
    }
    return null;
  }
  try {
    const invitation = parseInvitation(JSON.parse(fromUtf8(base64UrlDecode(match[1]))));
    logDiagnostic("invite", "accepted", { version: invitation.version, encodedLength: match[1].length });
    return invitation;
  } catch (error) {
    logDiagnostic("invite", "rejected-content", {
      encodedLength: match[1].length,
      reason: error instanceof Error ? error.message : "unknown",
    }, "warn");
    return null;
  }
}

export function clearInvitationFromAddressBar(): void {
  if (!window.location.hash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  logDiagnostic("invite", "removed-from-address-bar");
}

export function decodeInvitationSecret(invitation: Invitation): Uint8Array<ArrayBuffer> {
  const secret = base64UrlDecode(invitation.secret);
  if (secret.byteLength !== 32) throw new Error("Некорректный секрет приглашения");
  return secret;
}

export function parseInvitation(value: unknown): Invitation {
  if (!value || typeof value !== "object") throw new Error("Некорректное приглашение");
  const invitation = value as Record<string, unknown>;
  if (
    invitation.version !== PROTOCOL_VERSION ||
    typeof invitation.roomId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(invitation.roomId) ||
    typeof invitation.secret !== "string" ||
    base64UrlDecode(invitation.secret).byteLength !== 32 ||
    typeof invitation.creatorIdentity !== "string" ||
    base64UrlDecode(invitation.creatorIdentity).byteLength !== 65
  ) {
    throw new Error("Некорректные поля приглашения");
  }
  return invitation as unknown as Invitation;
}
