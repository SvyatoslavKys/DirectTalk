import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  concatBytes,
  fromUtf8,
  randomBytes,
  utf8,
} from "./encoding";

export const PROTOCOL_VERSION = 1 as const;
export type PeerRole = "creator" | "joiner";

export interface IdentityKeys {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyRaw: string;
}

export interface HelloMessage {
  type: "hello";
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  role: PeerRole;
  identityKey: string;
  ephemeralKey: string;
  nonce: string;
  name: string;
  proof: string;
  signature: string;
}

export interface SealedHelloMessage {
  type: "handshake";
  version: typeof PROTOCOL_VERSION;
  role: PeerRole;
  nonce: string;
  ciphertext: string;
}

export interface LocalHandshake {
  hello: HelloMessage;
  ephemeralPrivateKey: CryptoKey;
}

export interface VerifiedHello {
  hello: HelloMessage;
  identityPublicKey: CryptoKey;
  ephemeralPublicKey: CryptoKey;
}

export interface DerivedSession {
  cipher: SessionCipher;
  securityCode: string;
  peerId: string;
  peerFingerprint: string;
}

interface SessionKeys {
  creatorToJoinerKey: CryptoKey;
  joinerToCreatorKey: CryptoKey;
  creatorToJoinerPrefix: Uint8Array<ArrayBuffer>;
  joinerToCreatorPrefix: Uint8Array<ArrayBuffer>;
}

export async function createIdentityKeys(): Promise<IdentityKeys> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyRaw: base64UrlEncode(raw),
  };
}

export async function createLocalHandshake(
  identity: IdentityKeys,
  roomId: string,
  inviteSecret: Uint8Array<ArrayBuffer>,
  role: PeerRole,
  displayName: string,
): Promise<LocalHandshake> {
  assertRoomId(roomId);
  assertSecret(inviteSecret);
  const name = normalizeName(displayName);
  const ephemeralPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralKey = base64UrlEncode(await crypto.subtle.exportKey("raw", ephemeralPair.publicKey));

  const fields = {
    version: PROTOCOL_VERSION,
    roomId,
    role,
    identityKey: identity.publicKeyRaw,
    ephemeralKey,
    nonce: base64UrlEncode(randomBytes(16)),
    name,
  };
  const signedPayload = serializeHelloFields(fields);
  const hmacKey = await importHmacKey(inviteSecret);
  const [proof, signature] = await Promise.all([
    crypto.subtle.sign("HMAC", hmacKey, signedPayload),
    crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, signedPayload),
  ]);

  return {
    hello: {
      type: "hello",
      ...fields,
      proof: base64UrlEncode(proof),
      signature: base64UrlEncode(signature),
    },
    ephemeralPrivateKey: ephemeralPair.privateKey,
  };
}

export async function verifyRemoteHello(
  value: unknown,
  roomId: string,
  inviteSecret: Uint8Array<ArrayBuffer>,
  localRole: PeerRole,
  expectedCreatorIdentity?: string,
  expectedRemoteIdentity?: string,
): Promise<VerifiedHello> {
  const hello = parseHello(value);
  if (hello.roomId !== roomId || hello.role === localRole) throw new Error("Handshake относится к другому чату");
  if (hello.role === "creator" && expectedCreatorIdentity && hello.identityKey !== expectedCreatorIdentity) {
    throw new Error("Ключ создателя не совпадает с ключом в приглашении");
  }
  if (expectedRemoteIdentity && hello.identityKey !== expectedRemoteIdentity) {
    throw new Error("Ключ собеседника изменился при восстановлении соединения");
  }

  const identityBytes = decodeFixed(hello.identityKey, 65, "ключ устройства");
  const ephemeralBytes = decodeFixed(hello.ephemeralKey, 65, "сеансовый ключ");
  const proof = decodeFixed(hello.proof, 32, "proof");
  const signature = base64UrlDecode(hello.signature);
  if (signature.byteLength < 64 || signature.byteLength > 80) throw new Error("Некорректная подпись handshake");

  const [identityPublicKey, ephemeralPublicKey, hmacKey] = await Promise.all([
    crypto.subtle.importKey("raw", identityBytes, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
    crypto.subtle.importKey("raw", ephemeralBytes, { name: "ECDH", namedCurve: "P-256" }, true, []),
    importHmacKey(inviteSecret),
  ]);
  const signedPayload = serializeHelloFields(hello);
  const [validProof, validSignature] = await Promise.all([
    crypto.subtle.verify("HMAC", hmacKey, proof, signedPayload),
    crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, identityPublicKey, signature, signedPayload),
  ]);
  if (!validProof) throw new Error("Собеседник не владеет секретом приглашения");
  if (!validSignature) throw new Error("Подпись ключа устройства недействительна");

  return { hello, identityPublicKey, ephemeralPublicKey };
}

export async function sealHelloMessage(
  hello: HelloMessage,
  inviteSecret: Uint8Array<ArrayBuffer>,
): Promise<SealedHelloMessage> {
  const nonce = randomBytes(12);
  const key = await deriveHandshakeKey(inviteSecret, hello.roomId, hello.role);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: handshakeAdditionalData(hello.roomId, hello.role),
      tagLength: 128,
    },
    key,
    utf8(JSON.stringify(hello)),
  );
  return {
    type: "handshake",
    version: PROTOCOL_VERSION,
    role: hello.role,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

export async function openHelloMessage(
  value: unknown,
  roomId: string,
  inviteSecret: Uint8Array<ArrayBuffer>,
  localRole: PeerRole,
): Promise<unknown> {
  if (!value || typeof value !== "object") throw new Error("Некорректный защищённый handshake");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== "handshake" ||
    envelope.version !== PROTOCOL_VERSION ||
    !isRole(envelope.role) ||
    envelope.role === localRole ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    envelope.ciphertext.length > 4_096
  ) {
    throw new Error("Некорректный защищённый handshake");
  }
  const nonce = decodeFixed(envelope.nonce, 12, "handshake nonce");
  const key = await deriveHandshakeKey(inviteSecret, roomId, envelope.role);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: handshakeAdditionalData(roomId, envelope.role),
        tagLength: 128,
      },
      key,
      base64UrlDecode(envelope.ciphertext),
    );
  } catch {
    throw new Error("Собеседник не владеет секретом приглашения");
  }
  return JSON.parse(fromUtf8(plaintext));
}

export async function deriveSession(
  local: LocalHandshake,
  remote: VerifiedHello,
  inviteSecret: Uint8Array<ArrayBuffer>,
): Promise<DerivedSession> {
  const localRole = local.hello.role;
  const creatorHello = localRole === "creator" ? local.hello : remote.hello;
  const joinerHello = localRole === "joiner" ? local.hello : remote.hello;
  const transcript = serializeTranscript(creatorHello, joinerHello);

  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: remote.ephemeralPublicKey },
    local.ephemeralPrivateKey,
    256,
  );
  const keyMaterial = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const transcriptHash = await crypto.subtle.digest("SHA-256", transcript);
  const expanded = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: inviteSecret, info: concatBytes(utf8("DirectTalk session v1"), transcriptHash) },
    keyMaterial,
    576,
  );
  const bytes = new Uint8Array(expanded);
  const keys: SessionKeys = {
    creatorToJoinerKey: await importAesKey(bytes.slice(0, 32)),
    joinerToCreatorKey: await importAesKey(bytes.slice(32, 64)),
    creatorToJoinerPrefix: bytes.slice(64, 68),
    joinerToCreatorPrefix: bytes.slice(68, 72),
  };

  const sas = await crypto.subtle.sign("HMAC", await importHmacKey(inviteSecret), concatBytes(utf8("DirectTalk SAS v1"), transcriptHash));
  const peerDigest = await crypto.subtle.digest("SHA-256", base64UrlDecode(remote.hello.identityKey));
  return {
    cipher: new SessionCipher(local.hello.roomId, localRole, keys),
    securityCode: formatGroups(bytesToHex(sas).slice(0, 32), 4),
    peerId: base64UrlEncode(peerDigest),
    peerFingerprint: formatGroups(bytesToHex(peerDigest).slice(0, 32), 4),
  };
}

export class SessionCipher {
  private sendSequence = 0n;
  private receiveSequence = 0n;
  private readonly sendKey: CryptoKey;
  private readonly receiveKey: CryptoKey;
  private readonly sendPrefix: Uint8Array<ArrayBuffer>;
  private readonly receivePrefix: Uint8Array<ArrayBuffer>;
  private readonly sendDirection: string;
  private readonly receiveDirection: string;

  constructor(
    private readonly roomId: string,
    role: PeerRole,
    keys: SessionKeys,
  ) {
    const creator = role === "creator";
    this.sendKey = creator ? keys.creatorToJoinerKey : keys.joinerToCreatorKey;
    this.receiveKey = creator ? keys.joinerToCreatorKey : keys.creatorToJoinerKey;
    this.sendPrefix = creator ? keys.creatorToJoinerPrefix : keys.joinerToCreatorPrefix;
    this.receivePrefix = creator ? keys.joinerToCreatorPrefix : keys.creatorToJoinerPrefix;
    this.sendDirection = creator ? "creator-to-joiner" : "joiner-to-creator";
    this.receiveDirection = creator ? "joiner-to-creator" : "creator-to-joiner";
  }

  async seal(payload: unknown): Promise<string> {
    const sequence = this.sendSequence;
    this.sendSequence += 1n;
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: makeNonce(this.sendPrefix, sequence),
        additionalData: makeAdditionalData(this.roomId, this.sendDirection, sequence),
        tagLength: 128,
      },
      this.sendKey,
      utf8(JSON.stringify(payload)),
    );
    return JSON.stringify({ type: "sealed", version: PROTOCOL_VERSION, sequence: sequence.toString(), ciphertext: base64UrlEncode(ciphertext) });
  }

  async open(wireValue: unknown): Promise<unknown> {
    if (!wireValue || typeof wireValue !== "object") throw new Error("Некорректный зашифрованный пакет");
    const wire = wireValue as Record<string, unknown>;
    if (
      wire.type !== "sealed" ||
      wire.version !== PROTOCOL_VERSION ||
      typeof wire.sequence !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(wire.sequence) ||
      typeof wire.ciphertext !== "string" ||
      wire.ciphertext.length > 16_384
    ) {
      throw new Error("Некорректный формат зашифрованного пакета");
    }

    const sequence = BigInt(wire.sequence);
    if (sequence < this.receiveSequence) throw new Error("Нарушена последовательность защищённых пакетов");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: makeNonce(this.receivePrefix, sequence),
        additionalData: makeAdditionalData(this.roomId, this.receiveDirection, sequence),
        tagLength: 128,
      },
      this.receiveKey,
      base64UrlDecode(wire.ciphertext),
    );
    this.receiveSequence = sequence + 1n;
    return JSON.parse(fromUtf8(plaintext));
  }
}

function parseHello(value: unknown): HelloMessage {
  if (!value || typeof value !== "object") throw new Error("Некорректный handshake");
  const hello = value as Record<string, unknown>;
  if (
    hello.type !== "hello" ||
    hello.version !== PROTOCOL_VERSION ||
    typeof hello.roomId !== "string" ||
    !isRole(hello.role) ||
    typeof hello.identityKey !== "string" ||
    typeof hello.ephemeralKey !== "string" ||
    typeof hello.nonce !== "string" ||
    typeof hello.name !== "string" ||
    typeof hello.proof !== "string" ||
    typeof hello.signature !== "string"
  ) {
    throw new Error("Некорректные поля handshake");
  }
  assertRoomId(hello.roomId);
  decodeFixed(hello.nonce, 16, "nonce");
  normalizeName(hello.name);
  return hello as unknown as HelloMessage;
}

function serializeHelloFields(fields: Pick<HelloMessage, "version" | "roomId" | "role" | "identityKey" | "ephemeralKey" | "nonce" | "name">): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify([
      "DirectTalk hello",
      fields.version,
      fields.roomId,
      fields.role,
      fields.identityKey,
      fields.ephemeralKey,
      fields.nonce,
      fields.name,
    ]),
  );
}

function serializeTranscript(creator: HelloMessage, joiner: HelloMessage): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify([
      "DirectTalk transcript",
      PROTOCOL_VERSION,
      base64UrlEncode(serializeHelloFields(creator)),
      base64UrlEncode(serializeHelloFields(joiner)),
    ]),
  );
}

function makeNonce(prefix: Uint8Array<ArrayBuffer>, sequence: bigint): Uint8Array<ArrayBuffer> {
  if (sequence < 0n || sequence > 0xffff_ffff_ffff_ffffn) throw new Error("Исчерпан счётчик nonce");
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, sequence, false);
  return nonce;
}

function makeAdditionalData(roomId: string, direction: string, sequence: bigint): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(["DirectTalk sealed", PROTOCOL_VERSION, roomId, direction, sequence.toString()]));
}

function normalizeName(value: string): string {
  const name = value.trim().normalize("NFC");
  if (name.length < 1 || name.length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Имя должно содержать от 1 до 40 обычных символов");
  }
  return name;
}

function assertRoomId(value: string): void {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(value)) throw new Error("Некорректный идентификатор комнаты");
}

function assertSecret(secret: Uint8Array<ArrayBuffer>): void {
  if (secret.byteLength !== 32) throw new Error("Некорректный секрет приглашения");
}

function decodeFixed(value: string, length: number, label: string): Uint8Array<ArrayBuffer> {
  const decoded = base64UrlDecode(value);
  if (decoded.byteLength !== length) throw new Error(`Некорректное поле: ${label}`);
  return decoded;
}

function isRole(value: unknown): value is PeerRole {
  return value === "creator" || value === "joiner";
}

async function importHmacKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  assertSecret(secret);
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function importAesKey(value: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", value, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function deriveHandshakeKey(
  secret: Uint8Array<ArrayBuffer>,
  roomId: string,
  role: PeerRole,
): Promise<CryptoKey> {
  assertSecret(secret);
  assertRoomId(roomId);
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64UrlDecode(roomId),
      info: utf8(JSON.stringify(["DirectTalk protected hello", PROTOCOL_VERSION, role])),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function handshakeAdditionalData(roomId: string, role: PeerRole): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(["DirectTalk handshake envelope", PROTOCOL_VERSION, roomId, role]));
}

function formatGroups(value: string, groupSize: number): string {
  return value.match(new RegExp(`.{1,${groupSize}}`, "gu"))?.join(" ") ?? value;
}
