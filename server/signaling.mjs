import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";

const MAX_MESSAGES_PER_WINDOW = 180;
const RATE_WINDOW_MS = 60_000;
const MEMBER_TTL_SECONDS = 120;
const HEARTBEAT_MS = 25_000;
const REDIS_PREFIX = "directtalk:signal:v1";

export function createSignalingHttpServer(options = {}) {
  const allowedOrigins = readAllowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS);
  const requireSharedBroker = options.requireSharedBroker ?? Boolean(process.env.VERCEL);
  const broker = createBroker({ requireSharedBroker });
  const clients = new Map();

  broker.onDelivery((clientRef, message) => {
    const socket = clients.get(clientRef);
    if (socket) send(socket, message);
  });

  const server = createServer(async (_request, response) => {
    let available = broker.kind !== "unavailable";
    if (available) {
      try {
        await readyWithin(broker, 3_000);
      } catch {
        available = false;
      }
    }
    const status = available ? "ok" : broker.kind === "unavailable" ? "missing-redis" : "redis-unavailable";
    response.writeHead(available ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      service: "directtalk-signaling",
      status,
      sharedBroker: broker.kind === "redis",
      storesMessages: false,
    }));
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      done(isAllowedOrigin(info.origin, info.req, allowedOrigins), 403, "Origin not allowed");
    },
  });

  wss.on("connection", (socket) => {
    const context = {
      socketId: randomUUID(),
      clientRef: null,
      roomId: null,
      role: null,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
      alive: true,
      queue: Promise.resolve(),
    };
    socket.directTalkContext = context;

    socket.on("pong", () => {
      context.alive = true;
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary || !withinRateLimit(context)) {
        socket.close(1008, "Protocol policy violation");
        return;
      }

      context.queue = context.queue
        .then(() => handleMessage(socket, context, raw))
        .catch(() => {
          send(socket, { type: "error", code: "backend-unavailable" });
          socket.close(1011, "Signaling temporarily unavailable");
        });
    });

    socket.on("close", (_code, reason) => {
      void leaveRoom(context, reason.toString("utf8") !== "Signaling complete");
    });
    socket.on("error", () => {
      void leaveRoom(context, true);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const context = socket.directTalkContext;
      if (!context) continue;
      if (!context.alive) {
        socket.terminate();
        continue;
      }
      context.alive = false;
      socket.ping();
      if (context.roomId && context.role && context.clientRef) {
        void broker.touch(context.roomId, context.role, context.clientRef).then((owned) => {
          if (!owned && socket.readyState === WebSocket.OPEN) socket.close(1008, "Room ownership lost");
        }).catch(() => socket.close(1011, "Signaling temporarily unavailable"));
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeat);
    void broker.close();
  });
  wss.on("error", () => {
    console.error("DirectTalk WebSocket server error");
  });

  async function handleMessage(socket, context, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      send(socket, { type: "error", code: "invalid-json" });
      return;
    }

    if (message?.type === "join") {
      await joinRoom(socket, context, message);
      return;
    }

    if (message?.type === "signal") {
      await relaySignal(socket, context, message);
      return;
    }

    send(socket, { type: "error", code: "invalid-message" });
  }

  async function joinRoom(socket, context, message) {
    if (context.roomId || !isRoomId(message.roomId) || !isRole(message.role)) {
      send(socket, { type: "error", code: "invalid-join" });
      return;
    }

    await broker.ready();
    const clientRef = broker.clientRef(context.socketId);
    if (!await broker.register(message.roomId, message.role, clientRef)) {
      send(socket, { type: "error", code: "room-full" });
      return;
    }

    context.clientRef = clientRef;
    context.roomId = message.roomId;
    context.role = message.role;
    clients.set(clientRef, socket);
    send(socket, { type: "joined", role: message.role });

    const [creator, joiner] = await Promise.all([
      broker.lookup(message.roomId, "creator"),
      broker.lookup(message.roomId, "joiner"),
    ]);
    if (creator && joiner) {
      await Promise.all([
        broker.deliver(creator, { type: "peer-ready" }),
        broker.deliver(joiner, { type: "peer-ready" }),
      ]);
    }
  }

  async function relaySignal(socket, context, message) {
    if (!context.roomId || !context.role || !isSignalPayload(message.payload)) {
      send(socket, { type: "error", code: "invalid-signal" });
      return;
    }

    const targetRole = context.role === "creator" ? "joiner" : "creator";
    const target = await broker.lookup(context.roomId, targetRole);
    if (!target) {
      send(socket, { type: "error", code: "peer-unavailable" });
      return;
    }
    await broker.deliver(target, { type: "signal", payload: message.payload });
  }

  async function leaveRoom(context, notifyPeer) {
    if (!context.roomId || !context.role || !context.clientRef) return;
    const { roomId, role, clientRef } = context;
    context.roomId = null;
    context.role = null;
    context.clientRef = null;
    clients.delete(clientRef);

    const removed = await broker.remove(roomId, role, clientRef).catch(() => false);
    if (!removed || !notifyPeer) return;
    const otherRole = role === "creator" ? "joiner" : "creator";
    const peer = await broker.lookup(roomId, otherRole).catch(() => null);
    if (peer) await broker.deliver(peer, { type: "peer-left" }).catch(() => undefined);
  }

  return { server, wss, brokerKind: broker.kind };
}

class MemoryBroker {
  kind = "memory";
  instanceId = randomUUID();
  rooms = new Map();
  deliveryHandler = () => {};

  onDelivery(handler) { this.deliveryHandler = handler; }
  clientRef(socketId) { return `${this.instanceId}:${socketId}`; }
  async ready() {}

  async register(roomId, role, clientRef) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    if (room.has(role)) return false;
    room.set(role, clientRef);
    return true;
  }

  async lookup(roomId, role) { return this.rooms.get(roomId)?.get(role) ?? null; }

  async remove(roomId, role, clientRef) {
    const room = this.rooms.get(roomId);
    if (room?.get(role) !== clientRef) return false;
    room.delete(role);
    if (room.size === 0) this.rooms.delete(roomId);
    return true;
  }

  async touch(roomId, role, clientRef) { return this.rooms.get(roomId)?.get(role) === clientRef; }
  async deliver(clientRef, message) { this.deliveryHandler(clientRef, message); }
  async close() {}
}

class RedisBroker {
  kind = "redis";
  instanceId = randomUUID();
  deliveryHandler = () => {};

  constructor(url) {
    this.publisher = new Redis(url, redisOptions());
    this.subscriber = new Redis(url, redisOptions());
    this.channel = `${REDIS_PREFIX}:instance:${this.instanceId}`;
    this.readyPromise = this.subscriber.subscribe(this.channel);
    this.subscriber.on("message", (channel, raw) => {
      if (channel !== this.channel || typeof raw !== "string" || raw.length > 70_000) return;
      try {
        const event = JSON.parse(raw);
        if (typeof event?.clientRef === "string" && event.message && typeof event.message === "object") {
          this.deliveryHandler(event.clientRef, event.message);
        }
      } catch {
        // Ignore malformed events from a shared Redis deployment.
      }
    });
    this.publisher.on("error", logRedisError);
    this.subscriber.on("error", logRedisError);
  }

  onDelivery(handler) { this.deliveryHandler = handler; }
  clientRef(socketId) { return `${this.instanceId}:${socketId}`; }
  async ready() { await this.readyPromise; }

  async register(roomId, role, clientRef) {
    await this.ready();
    return await this.publisher.set(roomKey(roomId, role), clientRef, "EX", MEMBER_TTL_SECONDS, "NX") === "OK";
  }

  async lookup(roomId, role) { return await this.publisher.get(roomKey(roomId, role)); }

  async remove(roomId, role, clientRef) {
    const removed = await this.publisher.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      roomKey(roomId, role),
      clientRef,
    );
    return removed === 1;
  }

  async touch(roomId, role, clientRef) {
    const touched = await this.publisher.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      roomKey(roomId, role),
      clientRef,
      MEMBER_TTL_SECONDS,
    );
    return touched === 1;
  }

  async deliver(clientRef, message) {
    const separator = clientRef.indexOf(":");
    if (separator < 1) return;
    const targetInstance = clientRef.slice(0, separator);
    if (targetInstance === this.instanceId) {
      this.deliveryHandler(clientRef, message);
      return;
    }
    await this.publisher.publish(
      `${REDIS_PREFIX}:instance:${targetInstance}`,
      JSON.stringify({ clientRef, message }),
    );
  }

  async close() { await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]); }
}

class UnavailableBroker {
  kind = "unavailable";
  instanceId = randomUUID();
  onDelivery() {}
  clientRef(socketId) { return `${this.instanceId}:${socketId}`; }
  async ready() { throw new Error("REDIS_URL is required on Vercel"); }
  async register() { return false; }
  async lookup() { return null; }
  async remove() { return false; }
  async touch() { return false; }
  async deliver() {}
  async close() {}
}

function createBroker({ requireSharedBroker }) {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) return new RedisBroker(redisUrl);
  if (requireSharedBroker) return new UnavailableBroker();
  return new MemoryBroker();
}

function redisOptions() {
  return {
    connectTimeout: 8_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
  };
}

function logRedisError() { console.error("DirectTalk signaling Redis connection error"); }
function roomKey(roomId, role) { return `${REDIS_PREFIX}:room:${roomId}:${role}`; }

function readAllowedOrigins(value) {
  return new Set(
    (value ?? "http://127.0.0.1:5173,http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isAllowedOrigin(origin, request, allowedOrigins) {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const requestHost = request.headers.host;
    if (!requestHost || originUrl.host !== requestHost) return false;
    return originUrl.protocol === "https:" ||
      (originUrl.protocol === "http:" && (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function withinRateLimit(context) {
  const now = Date.now();
  if (now - context.windowStartedAt >= RATE_WINDOW_MS) {
    context.windowStartedAt = now;
    context.messagesInWindow = 0;
  }
  context.messagesInWindow += 1;
  return context.messagesInWindow <= MAX_MESSAGES_PER_WINDOW;
}

function isRoomId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value); }
function isRole(value) { return value === "creator" || value === "joiner"; }

function isSignalPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length !== 1) return false;

  if ("description" in payload) {
    const description = payload.description;
    return (
      description &&
      typeof description === "object" &&
      (description.type === "offer" || description.type === "answer") &&
      typeof description.sdp === "string" &&
      description.sdp.length <= 32_768
    );
  }

  if ("candidate" in payload) {
    const candidate = payload.candidate;
    return (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.candidate === "string" &&
      candidate.candidate.length <= 4_096
    );
  }

  return false;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function readyWithin(broker, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      broker.ready(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Signaling readiness timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
