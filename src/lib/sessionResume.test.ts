import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "./encoding";
import { createInvitation } from "./invite";
import { createIdentityKeys } from "./protocol";
import {
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
