# DirectTalk

A minimal private chat between two browsers. The signaling server only relays SDP/ICE data; after the connection is established, messages travel through a WebRTC DataChannel. Chat history is stored locally in IndexedDB.

> The current protocol has not undergone an independent cryptographic audit. It is a security-oriented MVP for development and concept validation, not a production-ready tool for situations where a failure could endanger a user's life, health, or freedom.

## Features

- one-time invitations via a link or locally generated QR code;
- explicit connection confirmation before revealing an IP address to the peer;
- a direct WebRTC DataChannel with Metered Open Relay TURN fallback for restrictive NATs and mobile networks;
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
- `api/turn.mjs` obtains Metered TURN credentials without exposing the long-lived Metered API key to the browser;
- the signaling backend relays only SDP and ICE while the connection is being established;
- once the encrypted DataChannel handshake succeeds, both browsers close their signaling WebSockets and continue peer to peer;
- Redis Cloud coordinates signaling sockets that land on different Vercel Function instances and rate-limits TURN credential requests using a keyed hash of the client address. It never stores messages, photos, names, encryption keys, raw IP addresses, or TURN secrets.

Vercel WebSocket Functions have a maximum lifetime. Before WebRTC is ready, the browser reconnects to signaling automatically. After WebRTC is ready, signaling is no longer needed.

## Deploy to Vercel

1. Push this directory to a GitHub repository.
2. In Vercel, create a project and import that repository. Vercel reads `vercel.json`; no build-setting changes are required.
3. In the Vercel Marketplace, add **Redis Cloud** to this project and make sure it creates a `REDIS_URL` environment variable for Production and Preview.
4. Create a free Metered Open Relay app/API key. Add its endpoint without the `apiKey` query parameter as `METERED_TURN_CREDENTIALS_URL` (for example, `https://your-app.metered.live/api/v1/turn/credentials`) and add the key as the sensitive `METERED_TURN_API_KEY`. Enable both for Production and Preview. These are server-side variables: never add `VITE_` to their names.
5. Optionally add Cloudflare Realtime TURN as a secondary provider through `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`. When both providers exist, Metered is tried first.
6. Optionally add a random server-side `TURN_RATE_LIMIT_SECRET`. The endpoint otherwise uses the primary provider secret as its HMAC key when storing an irreversible per-client rate-limit identifier in Redis.
7. Do not add `VITE_SIGNALING_URL` in Vercel. The browser automatically connects to `wss://<your-domain>/api/signal` on the same origin.
8. Redeploy after adding the variables, then open `https://<your-domain>/api/signal`. A configured deployment returns JSON with `"status":"ok"`, `"sharedBroker":true`, and `"storesMessages":false`.
9. Open the app on two different devices. Create an invitation on the first device and open it on the second. In Diagnostics, a working configuration shows `turn credentials-ready` with `"provider":"metered"` and `relayEnabled:true`. A restrictive-network connection should also produce at least one ICE entry with `"iceType":"relay"`.

Always test invitations on the stable production domain, not a temporary Vercel deployment URL. Set `VITE_PUBLIC_APP_URL` if the production domain is different from `https://direct-talk.vercel.app`.

## Connection diagnostics

The in-app **Diagnostics** button opens a mobile-friendly technical log. On a narrow screen it is shown as an `i` button in the top bar. The error screen also links directly to this panel.

The report records connection stages, signaling and WebRTC state changes, DataChannel state, and the encrypted-handshake stage. Use **Share logs** on a phone or **Copy logs** on desktop. It intentionally excludes message text, files, cryptographic keys, invitation secrets, SDP, ICE candidate values, and IP addresses. It records only the non-sensitive ICE route class (`host`, `srflx`, `prflx`, or `relay`). The log survives a normal reload in the same tab through `sessionStorage`, but a browser process crash may still remove it.

To test the deployed signaling endpoint from a terminal:

```bash
SIGNAL_TEST_URL=wss://your-domain.example/api/signal \
SIGNAL_TEST_ORIGIN=https://your-domain.example \
npm run test:signal
```

WebSockets on Vercel are currently a Public Beta. DirectTalk requests short-lived TURN credentials before creating the peer connection and falls back to STUN-only mode if the endpoint is not configured or temporarily unavailable. The fallback can still fail between restrictive networks, which is reported in Diagnostics.

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
- `METERED_TURN_CREDENTIALS_URL` — server-side Metered credentials endpoint without an `apiKey` query parameter; only HTTPS `*.metered.live/api/v1/turn/credentials` URLs are accepted.
- `METERED_TURN_API_KEY` — server-side Metered API key; mark it sensitive in Vercel.
- `CLOUDFLARE_TURN_KEY_ID` — optional server-side Cloudflare Realtime TURN key ID for fallback.
- `CLOUDFLARE_TURN_API_TOKEN` — optional Cloudflare key secret for fallback; mark it sensitive in Vercel.
- `TURN_CREDENTIAL_TTL_SECONDS` — optional Cloudflare credential lifetime; defaults to 21,600 seconds and is clamped to 10 minutes–12 hours.
- `TURN_RATE_LIMIT_SECRET` — optional independent HMAC secret for privacy-preserving per-client TURN request rate limiting.

Never place a long-lived TURN secret in a `VITE_*` variable: everything with that prefix is included in the client-side JavaScript. A production service should issue short-lived TURN credentials to the browser from a server-side endpoint.

## Versioning

`package.json` is the single source of the application version. Vite injects it into the footer and Diagnostics at build time. Every deployable code change must bump the version: patch for a compatible fix, minor for a new feature, and major for an incompatible application change. The WebRTC protocol version is tracked separately and must change only together with a compatibility and migration plan.

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
api/turn.mjs           same-origin short-lived TURN credential endpoint
vercel.json            Vercel build, Function, region, and security headers
SECURITY.md            threat model and security limitations
```

## Production checklist

- serve the client exclusively over HTTPS and signaling exclusively over WSS;
- configure CSP and the other headers documented in `SECURITY.md` on the HTTP server instead of relying only on the meta tag;
- allow only the production origin in `ALLOWED_ORIGINS`;
- configure Metered Open Relay TURN and verify that Diagnostics names the Metered provider and reports relay candidates on a restrictive-network test;
- do not add analytics, third-party scripts, or HTML rendering for message content;
- obtain an independent review of the protocol and implementation before making production-security claims;
- add protocol versioning and migrations before onboarding real users.

## Roadmap

1. Automated end-to-end testing in two isolated browser contexts.
2. An optional `relay-only` mode that hides each participant's IP address from the other peer.
3. Optional local-history encryption using a key protected by a user passphrase.
4. A PWA/offline shell and contact management.
5. Voice messages and additional file types, each with dedicated limits and a security model.
