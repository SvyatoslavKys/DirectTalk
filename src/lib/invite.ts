import { base64UrlDecode, base64UrlEncode, randomBytes, utf8, fromUtf8 } from "./encoding";
import { PROTOCOL_VERSION, type IdentityKeys } from "./protocol";

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
  const url = new URL(window.location.href);
  url.hash = `invite=${base64UrlEncode(utf8(JSON.stringify(invitation)))}`;
  return url.toString();
}

export function readInvitationFromLocation(): Invitation | null {
  const match = /^#invite=([A-Za-z0-9_-]+)$/u.exec(window.location.hash);
  if (!match || match[1].length > 2_048) return null;
  try {
    return parseInvitation(JSON.parse(fromUtf8(base64UrlDecode(match[1]))));
  } catch {
    return null;
  }
}

export function clearInvitationFromAddressBar(): void {
  if (!window.location.hash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

export function decodeInvitationSecret(invitation: Invitation): Uint8Array<ArrayBuffer> {
  const secret = base64UrlDecode(invitation.secret);
  if (secret.byteLength !== 32) throw new Error("Некорректный секрет приглашения");
  return secret;
}

function parseInvitation(value: unknown): Invitation {
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
