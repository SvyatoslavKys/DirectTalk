import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "./encoding";
import {
  createIdentityKeys,
  createLocalHandshake,
  deriveSession,
  openHelloMessage,
  sealHelloMessage,
  verifyRemoteHello,
  type HelloMessage,
} from "./protocol";

describe("DirectTalk cryptographic handshake", () => {
  it("derives matching directional keys and a shared safety code", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
    const [creatorLocal, joinerLocal] = await Promise.all([
      createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Алиса"),
      createLocalHandshake(joinerIdentity, roomId, secret, "joiner", "Боб"),
    ]);

    const [creatorView, joinerView] = await Promise.all([
      verifyRemoteHello(joinerLocal.hello, roomId, secret, "creator"),
      verifyRemoteHello(creatorLocal.hello, roomId, secret, "joiner", creatorIdentity.publicKeyRaw),
    ]);
    const [creatorSession, joinerSession] = await Promise.all([
      deriveSession(creatorLocal, creatorView, secret),
      deriveSession(joinerLocal, joinerView, secret),
    ]);

    expect(creatorSession.securityCode).toBe(joinerSession.securityCode);
    expect(creatorSession.peerId).not.toBe(joinerSession.peerId);
    expect(creatorSession.reconnectCapability).toEqual({
      ...joinerSession.reconnectCapability,
      role: "creator",
    });
    expect(joinerSession.reconnectCapability?.role).toBe("joiner");
    expect(creatorSession.reconnectCapability?.creatorIdentity).toBe(creatorIdentity.publicKeyRaw);
    expect(creatorSession.reconnectCapability?.secret).not.toBe(base64UrlEncode(secret));

    const creatorWire = await creatorSession.cipher.seal({ kind: "chat-message", text: "Привет" });
    await expect(joinerSession.cipher.open(JSON.parse(creatorWire))).resolves.toEqual({
      kind: "chat-message",
      text: "Привет",
    });

    const joinerWire = await joinerSession.cipher.seal({ kind: "ack", id: "one" });
    await expect(creatorSession.cipher.open(JSON.parse(joinerWire))).resolves.toEqual({ kind: "ack", id: "one" });
  });

  it("rejects a peer that does not know the invitation secret", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const realSecret = randomBytes(32);
    const wrongSecret = randomBytes(32);
    const identity = await createIdentityKeys();
    const local = await createLocalHandshake(identity, roomId, realSecret, "creator", "Алиса");

    await expect(verifyRemoteHello(local.hello, roomId, wrongSecret, "joiner", identity.publicKeyRaw)).rejects.toThrow(
      "секретом приглашения",
    );
  });

  it("pins either role to the previously authenticated peer during a restored session", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, originalJoiner, replacementJoiner] = await Promise.all([
      createIdentityKeys(),
      createIdentityKeys(),
      createIdentityKeys(),
    ]);
    const creator = await createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Alice");
    const replacement = await createLocalHandshake(replacementJoiner, roomId, secret, "joiner", "Mallory");

    await expect(verifyRemoteHello(
      replacement.hello,
      roomId,
      secret,
      "creator",
      undefined,
      originalJoiner.publicKeyRaw,
    )).rejects.toThrow("Ключ собеседника изменился");
    await expect(verifyRemoteHello(
      replacement.hello,
      roomId,
      secret,
      "creator",
      undefined,
      replacementJoiner.publicKeyRaw,
    )).resolves.toMatchObject({ hello: { identityKey: replacementJoiner.publicKeyRaw } });
    expect(creator.hello.identityKey).toBe(creatorIdentity.publicKeyRaw);
  });

  it("hides identity metadata inside a secret-protected handshake envelope", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const identity = await createIdentityKeys();
    const local = await createLocalHandshake(identity, roomId, secret, "creator", "Скрытое имя");
    const envelope = await sealHelloMessage(local.hello, secret);
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain("Скрытое имя");
    expect(serialized).not.toContain(identity.publicKeyRaw);
    await expect(openHelloMessage(envelope, roomId, secret, "joiner")).resolves.toEqual(local.hello);
    await expect(openHelloMessage(envelope, roomId, randomBytes(32), "joiner")).rejects.toThrow(
      "секретом приглашения",
    );
  });

  it("rejects a modified signed handshake", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const identity = await createIdentityKeys();
    const local = await createLocalHandshake(identity, roomId, secret, "creator", "Алиса");
    const tampered: HelloMessage = { ...local.hello, name: "Мэллори" };

    await expect(verifyRemoteHello(tampered, roomId, secret, "joiner", identity.publicKeyRaw)).rejects.toThrow();
  });

  it("authenticates reconnect feature negotiation and remains compatible with a legacy hello", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
    const [creatorLocal, joinerLocal] = await Promise.all([
      createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Alice"),
      createLocalHandshake(joinerIdentity, roomId, secret, "joiner", "Bob"),
    ]);
    const legacyJoiner: HelloMessage = { ...joinerLocal.hello };
    delete legacyJoiner.features;
    delete legacyJoiner.featureSignature;

    const [creatorView, joinerView] = await Promise.all([
      verifyRemoteHello(legacyJoiner, roomId, secret, "creator"),
      verifyRemoteHello(creatorLocal.hello, roomId, secret, "joiner", creatorIdentity.publicKeyRaw),
    ]);
    const [creatorSession, joinerSession] = await Promise.all([
      deriveSession({ ...creatorLocal }, creatorView, secret),
      deriveSession({ ...joinerLocal, hello: legacyJoiner }, joinerView, secret),
    ]);

    expect(creatorSession.reconnectCapability).toBeUndefined();
    expect(joinerSession.reconnectCapability).toBeUndefined();
    const wire = JSON.parse(await creatorSession.cipher.seal({ kind: "session-ready" }));
    await expect(joinerSession.cipher.open(wire)).resolves.toEqual({ kind: "session-ready" });
  });

  it("rejects a reconnect feature added without a valid identity signature", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const identity = await createIdentityKeys();
    const local = await createLocalHandshake(identity, roomId, secret, "creator", "Alice");
    const tampered: HelloMessage = {
      ...local.hello,
      features: ["reconnect-capability-v1", "forged-feature"],
    };

    await expect(verifyRemoteHello(tampered, roomId, secret, "joiner", identity.publicKeyRaw)).rejects.toThrow(
      "возможностей",
    );
  });

  it("rejects replayed encrypted packets", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
    const [creatorLocal, joinerLocal] = await Promise.all([
      createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Алиса"),
      createLocalHandshake(joinerIdentity, roomId, secret, "joiner", "Боб"),
    ]);
    const [creatorView, joinerView] = await Promise.all([
      verifyRemoteHello(joinerLocal.hello, roomId, secret, "creator"),
      verifyRemoteHello(creatorLocal.hello, roomId, secret, "joiner", creatorIdentity.publicKeyRaw),
    ]);
    const [creatorSession, joinerSession] = await Promise.all([
      deriveSession(creatorLocal, creatorView, secret),
      deriveSession(joinerLocal, joinerView, secret),
    ]);
    const wire = JSON.parse(await creatorSession.cipher.seal({ kind: "session-ready" }));

    await joinerSession.cipher.open(wire);
    await expect(joinerSession.cipher.open(wire)).rejects.toThrow("последовательность");
  });

  it("accepts an authenticated packet after a locally abandoned sequence", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
    const [creatorLocal, joinerLocal] = await Promise.all([
      createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Алиса"),
      createLocalHandshake(joinerIdentity, roomId, secret, "joiner", "Боб"),
    ]);
    const [creatorView, joinerView] = await Promise.all([
      verifyRemoteHello(joinerLocal.hello, roomId, secret, "creator"),
      verifyRemoteHello(creatorLocal.hello, roomId, secret, "joiner", creatorIdentity.publicKeyRaw),
    ]);
    const [creatorSession, joinerSession] = await Promise.all([
      deriveSession(creatorLocal, creatorView, secret),
      deriveSession(joinerLocal, joinerView, secret),
    ]);

    const abandonedWire = JSON.parse(await creatorSession.cipher.seal({ kind: "chat-message", text: "lost" }));
    const deliveredWire = JSON.parse(await creatorSession.cipher.seal({ kind: "chat-message", text: "delivered" }));

    await expect(joinerSession.cipher.open(deliveredWire)).resolves.toEqual({
      kind: "chat-message",
      text: "delivered",
    });
    await expect(joinerSession.cipher.open(abandonedWire)).rejects.toThrow("последовательность");
  });

  it("does not advance replay protection after a forged high sequence fails authentication", async () => {
    const roomId = base64UrlEncode(randomBytes(16));
    const secret = randomBytes(32);
    const [creatorIdentity, joinerIdentity] = await Promise.all([createIdentityKeys(), createIdentityKeys()]);
    const [creatorLocal, joinerLocal] = await Promise.all([
      createLocalHandshake(creatorIdentity, roomId, secret, "creator", "Алиса"),
      createLocalHandshake(joinerIdentity, roomId, secret, "joiner", "Боб"),
    ]);
    const [creatorView, joinerView] = await Promise.all([
      verifyRemoteHello(joinerLocal.hello, roomId, secret, "creator"),
      verifyRemoteHello(creatorLocal.hello, roomId, secret, "joiner", creatorIdentity.publicKeyRaw),
    ]);
    const [creatorSession, joinerSession] = await Promise.all([
      deriveSession(creatorLocal, creatorView, secret),
      deriveSession(joinerLocal, joinerView, secret),
    ]);
    const wire = JSON.parse(await creatorSession.cipher.seal({ kind: "session-ready" })) as Record<string, unknown>;

    await expect(joinerSession.cipher.open({ ...wire, sequence: "999" })).rejects.toThrow();
    await expect(joinerSession.cipher.open(wire)).resolves.toEqual({ kind: "session-ready" });
  });
});
