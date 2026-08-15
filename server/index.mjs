import { createSignalingHttpServer } from "./signaling.mjs";

const port = readPort(process.env.SIGNAL_PORT, 8787);
const host = process.env.SIGNAL_HOST?.trim() || "127.0.0.1";
const { server, brokerKind } = createSignalingHttpServer({ requireSharedBroker: false });

server.listen(port, host, () => {
  console.log(`DirectTalk signaling listening on ws://${host}:${port}`);
  console.log(`Signaling coordination: ${brokerKind}`);
});

server.on("error", (error) => {
  console.error(`Signaling server error: ${error.message}`);
  process.exitCode = 1;
});

function readPort(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SIGNAL_PORT must be an integer between 1 and 65535");
  }
  return parsed;
}
