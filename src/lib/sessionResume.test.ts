import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "./encoding";
import { createInvitation } from "./invite";
import { createIdentityKeys } from "./protocol";
import {
  clearResumableIntent,
  clearResumableSession,
  readResumableSession,
  RESUMABLE_SESSION_KEY,
  RESUMABLE_SESSION_MAX_AGE_MS,
  updateResumablePeerIdentity,
  writeResumableSession,
} from "./sessionResume";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("reload session recovery", () => {
  it("keeps a validated conversation context for the current tab", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    writeResumableSession({ invitation, role: "creator", displayName: "Alice" }, storage, 1_000);

    expect(readResumableSession(storage, 2_000)).toMatchObject({
      format: 1,
      invitation,
      role: "creator",
      displayName: "Alice",
      savedAt: 1_000,
    });
  });

  it("pins the known peer identity for a resumed handshake", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    const peerIdentity = base64UrlEncode(randomBytes(65));
    writeResumableSession({ invitation, role: "joiner", displayName: "Bob" }, storage, 1_000);
    updateResumablePeerIdentity(peerIdentity, storage, 2_000);

    expect(readResumableSession(storage, 2_001)?.expectedPeerIdentity).toBe(peerIdentity);
  });

  it("round-trips a saved-chat reconnect with its share and removal context", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    const peerIdentity = base64UrlEncode(randomBytes(65));
    const intentId = "12345678-1234-4abc-8def-1234567890ab";
    writeResumableSession({
      invitation,
      role: "creator",
      displayName: "Alice",
      expectedPeerIdentity: peerIdentity,
      sharePending: true,
      intent: "remove-conversation",
      intentId,
    }, storage, 1_000);

    expect(readResumableSession(storage, 2_000)).toMatchObject({
      invitation,
      role: "creator",
      displayName: "Alice",
      sharePending: true,
      intent: "remove-conversation",
      intentId,
    });
  });

  it("preserves the removal intent but clears a pending share after the secure handshake", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    const peerIdentity = base64UrlEncode(randomBytes(65));
    const intentId = "12345678-1234-4abc-8def-1234567890ab";
    writeResumableSession({
      invitation,
      role: "creator",
      displayName: "Alice",
      expectedPeerIdentity: peerIdentity,
      sharePending: true,
      intent: "remove-conversation",
      intentId,
    }, storage, 1_000);
    updateResumablePeerIdentity(peerIdentity, storage, 2_000);

    expect(readResumableSession(storage, 2_001)).toMatchObject({
      expectedPeerIdentity: peerIdentity,
      intent: "remove-conversation",
      intentId,
    });
    expect(readResumableSession(storage, 2_001)?.sharePending).toBeUndefined();
  });

  it("clears a completed intent without losing recovery context", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    const peerIdentity = base64UrlEncode(randomBytes(65));
    const intentId = "12345678-1234-4abc-8def-1234567890ab";
    writeResumableSession({
      invitation,
      role: "creator",
      displayName: "Alice",
      expectedPeerIdentity: peerIdentity,
      sharePending: true,
      intent: "remove-conversation",
      intentId,
    }, storage, 1_000);

    clearResumableIntent(storage, 2_000);

    expect(readResumableSession(storage, 2_001)).toMatchObject({
      invitation,
      role: "creator",
      displayName: "Alice",
      expectedPeerIdentity: peerIdentity,
      sharePending: true,
    });
    expect(readResumableSession(storage, 2_001)?.intent).toBeUndefined();
    expect(readResumableSession(storage, 2_001)?.intentId).toBeUndefined();
  });

  it("rejects unknown recovery intents", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    storage.setItem(RESUMABLE_SESSION_KEY, JSON.stringify({
      format: 1,
      invitation,
      role: "creator",
      displayName: "Alice",
      intent: "send-message",
      savedAt: 1_000,
    }));

    expect(readResumableSession(storage, 2_000)).toBeNull();
    expect(storage.values.has(RESUMABLE_SESSION_KEY)).toBe(false);
  });

  it("rejects invalid sharing and intent combinations", async () => {
    const invitation = createInvitation(await createIdentityKeys());
    const peerIdentity = base64UrlEncode(randomBytes(65));
    const invalidRecords = [
      { sharePending: "yes" },
      { role: "joiner", sharePending: true },
      { intent: "remove-conversation" },
      { intentId: "12345678-1234-4abc-8def-1234567890ab" },
      { intent: "remove-conversation", intentId: "not-a-uuid" },
      { intent: "remove-conversation", intentId: "12345678-1234-4ABC-8DEF-1234567890AB" },
      {
        role: "joiner",
        expectedPeerIdentity: peerIdentity,
        intent: "remove-conversation",
        intentId: "12345678-1234-4abc-8def-1234567890ab",
      },
    ];

    for (const invalid of invalidRecords) {
      const storage = memoryStorage();
      storage.setItem(RESUMABLE_SESSION_KEY, JSON.stringify({
        format: 1,
        invitation,
        role: "creator",
        displayName: "Alice",
        savedAt: 1_000,
        ...invalid,
      }));

      expect(readResumableSession(storage, 2_000)).toBeNull();
      expect(storage.values.has(RESUMABLE_SESSION_KEY)).toBe(false);
    }
  });

  it("drops expired or malformed recovery data", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    writeResumableSession({ invitation, role: "creator", displayName: "Alice" }, storage, 1_000);
    expect(readResumableSession(storage, 1_000 + RESUMABLE_SESSION_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.values.has(RESUMABLE_SESSION_KEY)).toBe(false);

    storage.setItem(RESUMABLE_SESSION_KEY, "{broken");
    expect(readResumableSession(storage, 2_000)).toBeNull();
    expect(storage.values.has(RESUMABLE_SESSION_KEY)).toBe(false);
  });

  it("clears recovery data on an explicit exit", async () => {
    const storage = memoryStorage();
    const invitation = createInvitation(await createIdentityKeys());
    writeResumableSession({ invitation, role: "creator", displayName: "Alice" }, storage, 1_000);
    clearResumableSession(storage);
    expect(readResumableSession(storage, 1_001)).toBeNull();
  });
});
