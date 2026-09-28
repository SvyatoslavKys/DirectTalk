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
  readReceiptPending?: boolean;
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
  hiddenAt?: number;
}

export interface StoredChatSummary {
  contact: StoredContact;
  lastMessage?: StoredMessage;
  messageCount: number;
  unreadCount: number;
  activityAt: number;
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

export function aggregateChatSummaries(
  contacts: readonly StoredContact[],
  messages: readonly StoredMessage[],
): StoredChatSummary[] {
  const summaries = new Map<string, StoredChatSummary>();

  for (const contact of contacts) {
    if (contact.hiddenAt !== undefined) continue;
    summaries.set(contact.id, {
      contact,
      messageCount: 0,
      unreadCount: 0,
      activityAt: contact.lastSeenAt,
    });
  }

  for (const message of messages) {
    const summary = summaries.get(message.chatId);
    if (!summary) continue;

    summary.messageCount += 1;
    if (message.sender === "peer" && message.status !== "read") summary.unreadCount += 1;

    const previous = summary.lastMessage;
    if (
      !previous ||
      message.createdAt > previous.createdAt ||
      (message.createdAt === previous.createdAt && message.id.localeCompare(previous.id) > 0)
    ) {
      summary.lastMessage = message;
    }
    summary.activityAt = Math.max(summary.activityAt, message.createdAt);
  }

  return [...summaries.values()].sort((left, right) =>
    right.activityAt - left.activityAt || left.contact.id.localeCompare(right.contact.id),
  );
}

export async function loadChatSummaries(): Promise<StoredChatSummary[]> {
  return db.transaction("r", db.contacts, db.messages, async () => {
    const [contacts, messages] = await Promise.all([
      db.contacts.toArray(),
      db.messages.toArray(),
    ]);
    return aggregateChatSummaries(contacts, messages);
  });
}

export async function hideChatLocally(chatId: string, now = Date.now()): Promise<void> {
  await db.transaction("rw", db.contacts, db.messages, db.attachments, async () => {
    const contact = await db.contacts.get(chatId);
    await db.attachments.where("chatId").equals(chatId).delete();
    await db.messages.where("chatId").equals(chatId).delete();
    if (contact) await db.contacts.put({ ...contact, hiddenAt: now });
  });
}
