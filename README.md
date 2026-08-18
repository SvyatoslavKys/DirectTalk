# DirectTalk

A minimal private chat between two browsers. The signaling server only relays SDP/ICE data; after the connection is established, messages travel through a WebRTC DataChannel. Chat history is stored locally in IndexedDB.

> The current protocol has not undergone an independent cryptographic audit. It is a security-oriented MVP for development and concept validation, not a production-ready tool for situations where a failure could endanger a user's life, health, or freedom.

## Features

- one-time invitations via a link or locally generated QR code;
- explicit connection confirmation before revealing an IP address to the peer;
- a direct WebRTC DataChannel, with the option to add TURN as a fallback;
- additional end-to-end encryption on top of DTLS without trusting the signaling server;
- a persistent local device key and signed ephemeral session keys;
- a safety code and persistent verified-contact status;
- local chat history through Dexie/IndexedDB;
- `delivered` and `read` receipts;
- direct transfer of JPEG, PNG, WebP, and GIF images up to 10 MB: the recipient approves the download, data is sent in encrypted chunks with backpressure, and the completed file is verified with SHA-256;
- local deletion of any message and confirmed deletion of the user's own sent messages from both participants;
- complete local chat clearing, or a request to clear both copies with the peer's explicit consent;
- English, Polish, Russian, and Ukrainian interfaces with browser-language detection and a locally remembered manual choice;
- no accounts, server-side database, or server-side message history.

## Production architecture on Vercel

DirectTalk deploys as one Vercel project:

- Vite builds the React frontend and Vercel serves it over HTTPS;
- `api/signal.mjs` exposes the same-origin WebSocket endpoint at `/api/signal`;
- the signaling backend relays only SDP and ICE while the connection is being established;
- once the encrypted DataChannel handshake succeeds, both browsers close their signaling WebSockets and continue peer to peer;
- Redis Cloud coordinates signaling sockets that land on different Vercel Function instances. It contains only short-lived room-role leases and transient Pub/Sub events, never messages, photos, names, or encryption keys.

Vercel WebSocket Functions have a maximum lifetime. Before WebRTC is ready, the browser reconnects to signaling automatically. After WebRTC is ready, signaling is no longer needed.

## Deploy to Vercel

1. Push this directory to a GitHub repository.
2. In Vercel, create a project and import that repository. Vercel reads `vercel.json`; no build-setting changes are required.
3. In the Vercel Marketplace, add **Redis Cloud** to this project and make sure it creates a `REDIS_URL` environment variable for Production and Preview.
4. Do not add `VITE_SIGNALING_URL` in Vercel. The browser automatically connects to `wss://<your-domain>/api/signal` on the same origin.
5. Deploy, then open `https://<your-domain>/api/signal`. A configured deployment returns JSON with `"status":"ok"`, `"sharedBroker":true`, and `"storesMessages":false`.
6. Open the app on two different devices. Create an invitation on the first device and open it on the second.

Always test invitations on the stable production domain, not a temporary Vercel deployment URL. Set `VITE_PUBLIC_APP_URL` if the production domain is different from `https://direct-talk.vercel.app`.

## Connection diagnostics

The in-app **Diagnostics** button opens a mobile-friendly technical log. On a narrow screen it is shown as an `i` button in the top bar. The error screen also links directly to this panel.

The report records connection stages, signaling and WebRTC state changes, DataChannel state, and the encrypted-handshake stage. Use **Share logs** on a phone or **Copy logs** on desktop. It intentionally excludes message text, files, cryptographic keys, invitation secrets, SDP, ICE candidates, and IP addresses. The log survives a normal reload in the same tab through `sessionStorage`, but a browser process crash may still remove it.

To test the deployed signaling endpoint from a terminal:

```bash
SIGNAL_TEST_URL=wss://your-domain.example/api/signal \
SIGNAL_TEST_ORIGIN=https://your-domain.example \
npm run test:signal
```

WebSockets on Vercel are currently a Public Beta. For networks where a direct WebRTC path cannot be created, a production deployment still needs TURN with short-lived credentials.

## Local development

Node.js 22 or later is required.

```bash
npm install
npm run signal
```

In a second terminal:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. To test two participants on one computer, use separate browser profiles or a regular and a private window. Tabs in the same profile share the same device key and IndexedDB database.

Run the project checks with:

```bash
npm run check
```

## Environment variables

See `.env.example` for an example configuration.

- `VITE_SIGNALING_URL` — WebSocket signaling URL; production deployments must use `wss://`.
- `VITE_STUN_URL` — STUN URL; defaults to `stun:stun.cloudflare.com:3478`.
- `VITE_PUBLIC_APP_URL` — stable public HTTPS origin used for invitation links; optional when deploying to `https://direct-talk.vercel.app`.
- `SIGNAL_PORT` — signaling-server port; defaults to `8787`.
- `SIGNAL_HOST` — listening interface; defaults to `127.0.0.1` and is usually `0.0.0.0` inside a container.
- `ALLOWED_ORIGINS` — comma-separated list of exact allowed origins.
- `REDIS_URL` — Redis connection URL used only to coordinate Vercel Function instances; required on Vercel and optional for the single-process local server.

Never place a long-lived TURN secret in a `VITE_*` variable: everything with that prefix is included in the client-side JavaScript. A production service should issue short-lived TURN credentials to the browser from a server-side endpoint.

## Project structure

```text
src/lib/protocol.ts    application handshake, HKDF, and AES-GCM
src/lib/connection.ts  WebRTC, signaling, and the encrypted messaging protocol
src/lib/photos.ts      image validation, chunking, and hashing
src/lib/i18n.ts        translations, language detection, and runtime-error localization
src/lib/diagnostics.ts privacy-safe in-browser connection diagnostics
src/lib/database.ts    device key, contacts, messages, and attachments
server/signaling.mjs   signaling protocol and in-memory/Redis coordination
server/index.mjs       local signaling-server entrypoint
api/signal.mjs         Vercel WebSocket Function entrypoint
vercel.json            Vercel build, Function, region, and security headers
SECURITY.md            threat model and security limitations
```

## Production checklist

- serve the client exclusively over HTTPS and signaling exclusively over WSS;
- configure CSP and the other headers documented in `SECURITY.md` on the HTTP server instead of relying only on the meta tag;
- allow only the production origin in `ALLOWED_ORIGINS`;
- deploy your own STUN/TURN service, or use a provider that issues short-lived credentials;
- do not add analytics, third-party scripts, or HTML rendering for message content;
- obtain an independent review of the protocol and implementation before making production-security claims;
- add protocol versioning and migrations before onboarding real users.

## Roadmap

1. Automated end-to-end testing in two isolated browser contexts.
2. A TURN credential endpoint and a `relay-only` mode that hides each participant's IP address from the other peer.
3. Optional local-history encryption using a key protected by a user passphrase.
4. A PWA/offline shell and contact management.
5. Voice messages and additional file types, each with dedicated limits and a security model.
