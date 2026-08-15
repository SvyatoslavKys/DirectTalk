import Dexie, { type EntityTable } from "dexie";
import { createIdentityKeys, type IdentityKeys } from "./protocol";

export type MessageStatus = "sending" | "delivered" | "read" | "failed";

export interface StoredIdentity {
  id: "device";
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyRaw: string;
  createdAt: number;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  sender: "me" | "peer";
  text: string;
  createdAt: number;
  status: MessageStatus;
  kind?: "text" | "photo";
  attachmentId?: string;
}

export interface StoredAttachment {
  id: string;
  messageId: string;
  chatId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  blob: Blob;
  createdAt: number;
}

export interface StoredContact {
  id: string;
  name: string;
  identityKey: string;
  fingerprint: string;
  verified: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

class DirectTalkDatabase extends Dexie {
  identities!: EntityTable<StoredIdentity, "id">;
  messages!: EntityTable<StoredMessage, "id">;
  contacts!: EntityTable<StoredContact, "id">;
  attachments!: EntityTable<StoredAttachment, "id">;

  constructor() {
    super("directtalk");
    this.version(1).stores({
      identities: "id",
      messages: "id, chatId, [chatId+createdAt]",
      contacts: "id, lastSeenAt",
    });
    this.version(2).stores({
      identities: "id",
      messages: "id, chatId, [chatId+createdAt]",
      contacts: "id, lastSeenAt",
      attachments: "id, messageId, chatId",
    });
  }
}

export const db = new DirectTalkDatabase();
let identityPromise: Promise<IdentityKeys> | undefined;

export async function getOrCreateIdentity(): Promise<IdentityKeys> {
  identityPromise ??= loadOrCreateIdentity().catch((error: unknown) => {
    identityPromise = undefined;
    throw error;
  });
  return identityPromise;
}

async function loadOrCreateIdentity(): Promise<IdentityKeys> {
  const existing = await db.identities.get("device");
  if (existing) {
    return {
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
      publicKeyRaw: existing.publicKeyRaw,
    };
  }

  const identity = await createIdentityKeys();
  try {
    await db.identities.add({ id: "device", ...identity, createdAt: Date.now() });
    return identity;
  } catch (error) {
    const concurrentIdentity = await db.identities.get("device");
    if (!concurrentIdentity) throw error;
    return {
      publicKey: concurrentIdentity.publicKey,
      privateKey: concurrentIdentity.privateKey,
      publicKeyRaw: concurrentIdentity.publicKeyRaw,
    };
  }
}

export async function loadMessages(chatId: string): Promise<StoredMessage[]> {
  return db.messages.where("chatId").equals(chatId).sortBy("createdAt");
}

export async function loadAttachments(chatId: string): Promise<StoredAttachment[]> {
  return db.attachments.where("chatId").equals(chatId).toArray();
}
