import { createSignalingHttpServer } from "../server/signaling.mjs";

const { server } = createSignalingHttpServer({ requireSharedBroker: true });

export default server;
