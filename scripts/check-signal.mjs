import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

const url = process.env.SIGNAL_TEST_URL || "ws://127.0.0.1:8787";
const origin = process.env.SIGNAL_TEST_ORIGIN || "http://127.0.0.1:5173";
const roomId = randomBytes(16).toString("base64url");
const options = { headers: { Origin: origin } };
const creator = new WebSocket(url, options);
const joiner = new WebSocket(url, options);

try {
  await Promise.all([opened(creator), opened(joiner)]);
  const creatorJoined = nextType(creator, "joined");
  const joinerJoined = nextType(joiner, "joined");
  const creatorReady = nextType(creator, "peer-ready");
  const joinerReady = nextType(joiner, "peer-ready");

  creator.send(JSON.stringify({ type: "join", roomId, role: "creator" }));
  joiner.send(JSON.stringify({ type: "join", roomId, role: "joiner" }));
  await Promise.all([creatorJoined, joinerJoined, creatorReady, joinerReady]);

  const relayed = nextType(joiner, "signal");
  creator.send(
    JSON.stringify({
      type: "signal",
      payload: { description: { type: "offer", sdp: "v=0\r\n" } },
    }),
  );
  const message = await relayed;
  if (message.payload?.description?.type !== "offer") throw new Error("Offer was not relayed");

  console.log("Signaling integration check passed");
} finally {
  creator.close();
  joiner.close();
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out while opening websocket")), 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
}

function nextType(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, 3_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type !== expectedType) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
