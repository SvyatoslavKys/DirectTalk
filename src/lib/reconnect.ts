import { base64UrlDecode } from "./encoding";

export const RECONNECT_CAPABILITY_VERSION = 1 as const;
export const RECONNECT_PROTOCOL_FEATURE = "reconnect-capability-v1" as const;

export type ReconnectRole = "creator" | "joiner";

/**
 * A capability shared only by the two authenticated peers. It is derived from
 * their ephemeral ECDH exchange and can therefore be used as a private,
 * persistent signaling rendezvous without re-sharing the original QR code.
 */
export interface ReconnectCapability {
  version: typeof RECONNECT_CAPABILITY_VERSION;
  roomId: string;
  secret: string;
  creatorIdentity: string;
  role: ReconnectRole;
}

export interface ReconnectInvitation {
  version: typeof RECONNECT_CAPABILITY_VERSION;
  roomId: string;
  secret: string;
  creatorIdentity: string;
}

export function parseReconnectCapability(value: unknown): ReconnectCapability {
  if (!value || typeof value !== "object") throw new Error("Invalid reconnect capability");
  const capability = value as Record<string, unknown>;
  if (
    capability.version !== RECONNECT_CAPABILITY_VERSION ||
    typeof capability.roomId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(capability.roomId) ||
    typeof capability.secret !== "string" ||
    decodeLength(capability.secret) !== 32 ||
    typeof capability.creatorIdentity !== "string" ||
    decodeLength(capability.creatorIdentity) !== 65 ||
    (capability.role !== "creator" && capability.role !== "joiner")
  ) {
    throw new Error("Invalid reconnect capability fields");
  }
  return capability as unknown as ReconnectCapability;
}

export function decodeReconnectSecret(capability: ReconnectCapability): Uint8Array<ArrayBuffer> {
  return base64UrlDecode(parseReconnectCapability(capability).secret);
}

export function reconnectInvitation(capability: ReconnectCapability): ReconnectInvitation {
  const parsed = parseReconnectCapability(capability);
  return {
    version: parsed.version,
    roomId: parsed.roomId,
    secret: parsed.secret,
    creatorIdentity: parsed.creatorIdentity,
  };
}

function decodeLength(value: string): number {
  try {
    return base64UrlDecode(value).byteLength;
  } catch {
    return -1;
  }
}
