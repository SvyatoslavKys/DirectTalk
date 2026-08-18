# DirectTalk Security

## Status

Version `0.1.0` is a security-oriented MVP that has not undergone an independent audit. It uses standard Web Crypto primitives, but their composition is the DirectTalk protocol and requires external review before production use.

## Threat model

The following are considered potentially untrusted:

- the network between the browsers, signaling server, STUN server, and TURN server;
- the signaling server, which can read, drop, modify, and reorder signaling messages;
- the TURN server, which can observe metadata and relay packets;
- a person who happens to guess a room identifier;
- replayed or modified packets;
- the remote peer's display name and message text.

DirectTalk cannot protect against:

- a malicious or already compromised browser or device;
- XSS or modified JavaScript already running within the DirectTalk origin;
- a web-hosting operator who replaces the application before it loads, because the web application has access to plaintext and key operations;
- a person who obtains the complete invitation link and impersonates the expected guest when the participants do not compare their safety code;
- deletion or copying of a browser profile and its local history;
- metadata analysis: signaling can observe IP addresses, connection times, the room ID, and ICE/SDP data; STUN, TURN, and the peer receive network metadata;
- denial of service: signaling can refuse to connect the participants or interrupt channel establishment.

## Why WebRTC alone is not enough

A WebRTC DataChannel uses SCTP over DTLS and provides transport confidentiality, integrity, and authentication. However, the DTLS fingerprint is exchanged through signaling. [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html#section-9.1) explicitly notes that even an HTTPS signaling server can perform a man-in-the-middle attack without independent key verification. [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html) describes the secure DataChannel stack.

PairDrop uses WebRTC and a server without a database, but the project [separately warns](https://github.com/schlagmichdoch/pairdrop/blob/master/docs/faq.md#what-about-security-are-my-files-encrypted-while-sent-between-the-computers) that the server must still be trusted until zero-trust verification is implemented. DirectTalk addresses this specific gap with an application-level handshake.

## DirectTalk v1 handshake

1. The creator generates a random 128-bit `roomId` and a random 256-bit `inviteSecret`.
2. The `roomId`, secret, and creator's public identity key are placed in the `#invite=...` fragment. URL fragments are not sent to the HTTP server. Before the guest connects, the application removes the fragment from the address bar.
3. Each browser profile stores a long-lived ECDSA P-256 key pair in IndexedDB. The private `CryptoKey` is created as non-extractable.
4. Each participant generates a fresh ECDH P-256 key pair and random nonce for every session.
5. The handshake fields contain the protocol version, room, role, identity key, ephemeral key, nonce, and display name. They are signed with ECDSA and authenticated with HMAC-SHA-256 using the `inviteSecret`.
6. Before transmission, the complete handshake is encrypted with a separate AES-256-GCM key derived from the `inviteSecret`, room, and role. As a result, a signaling server that actively splits WebRTC into two DTLS channels cannot learn the display name or identity key without the invitation secret.
7. The guest additionally verifies that the creator's identity key matches the key embedded in the invitation.
8. The shared ECDH secret is passed to HKDF-SHA-256. The `inviteSecret` is used as the salt, and the complete transcript hash is used as context. HKDF independently derives two AES-256-GCM keys and two directional nonce prefixes.
9. The participants exchange an initial encrypted `session-ready` message. The chat becomes available only after bidirectional key confirmation.
10. Every AES-GCM packet receives a 96-bit nonce: `direction-prefix || uint64 sequence`. The room, direction, and sequence number are included in the additional authenticated data. A skipped or repeated sequence number closes the connection.
11. The safety code is derived from an HMAC of the invitation secret and complete handshake transcript. Participants compare this code over an independent channel. After verification, the contact's identity key is treated as pinned.

This design uses fresh session keys but does not implement a Double Ratchet within a session. Offline delivery and post-compromise security should use a reviewed protocol implementation such as the [Signal Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) instead of extending this design with an improvised ratchet. Signal also [requires authentication of identity keys](https://signal.org/docs/specifications/sesame/#authentication), for example by comparing a fingerprint or QR code.

Web Crypto supports storing `CryptoKey` objects in IndexedDB, as described in [Web Cryptography Level 2](https://www.w3.org/TR/webcrypto-2/#concepts-key-storage). A non-extractable key does not protect against active malicious JavaScript: such code can still ask the browser to sign or decrypt data.

## What the server can see

The signaling server can see:

- the WebSocket client's IP address;
- the room ID, participant roles, signaling time, and signaling volume;
- the SDP and ICE candidates required by WebRTC;
- disconnect events.

The DirectTalk signaling protocol does not provide the server with:

- the invitation secret;
- names or identity keys from the application-level handshake;
- plaintext, messages, or chat history;
- application encryption keys.

A TURN server relays already encrypted WebRTC traffic, but it can still observe IP addresses and timing. A public STUN server also receives network metadata. Direct peer-to-peer communication inherently reveals a participant's network address to the other peer. Using TURN with `iceTransportPolicy: "relay"` can hide this address from the peer at the cost of trusting the relay with metadata and paying the additional relay cost.

## Images

JPEG, PNG, WebP, and GIF images are transferred only after the recipient explicitly accepts them. The maximum size is 10 MB. A file is divided into small ordered packets, each protected by the same AES-256-GCM session. Before saving it, the recipient verifies the declared size, chunk count, file signature, image decodability, and SHA-256 digest of the complete file. A mismatch causes the transfer to be discarded.

DirectTalk does not strip EXIF or other embedded metadata. Images are transferred unchanged and may retain coordinates, camera model, and capture time. Previewing and downloading use a local Blob URL; the file is never uploaded to the signaling server.

## Local history

Message text and sent or received images are currently stored as plaintext in IndexedDB. Meaningful encryption at rest requires a separate user secret or system key store; placing a key next to the ciphertext in the same browser profile does not honestly protect against a compromised origin. The interface can delete an individual message or clear the current chat. Complete removal of all data for the origin is still performed through the browser's site-data settings.

## Deletion semantics

- Any message can be deleted from the user's own IndexedDB.
- With “delete for both,” a participant can ask the peer to delete only a message that participant originally sent. The recipient checks the stored message direction and rejects attempts to delete the recipient's own messages.
- Clearing both copies is never performed automatically by a remote command. The other participant sees a request and must explicitly accept it.
- Deletion commands travel inside the end-to-end encrypted session and work only while both browsers are connected. The server does not queue deletion commands.
- Deletion is best effort. A modified client can ignore a request, and DirectTalk cannot erase an exported file, backup, screenshot, or data stored in another browser profile.
- Removing an IndexedDB record does not guarantee physical erasure of storage blocks. High-assurance environments should use full-disk encryption and delete the complete browser profile when necessary.

## Deployment requirements

The HTTP server hosting a production build should send at least the following headers:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://signal.example; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=63072000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
```

The meta CSP in `index.html` provides additional protection and supports local development. The `frame-ancestors` directive works only when delivered as an HTTP header.

Production deployments should also:

- avoid logging room IDs, SDP, ICE, and IP addresses unless operationally necessary;
- limit the size and frequency of WebSocket messages;
- use an exact origin allowlist;
- use Redis only for short-lived signaling coordination and disable persistence/diagnostic logging where the provider allows it;
- keep the long-lived Cloudflare TURN key exclusively in server-side environment variables and issue credentials with a short time to live;
- protect the TURN credential endpoint with an exact same-origin check, no-store responses, strict response validation, and Redis-backed request rate limiting;
- avoid third-party JavaScript, CDN-hosted fonts, analytics, and error trackers that could access application data;
- publish reproducible builds and release hashes once a release process exists.

## Reporting a vulnerability

Until a private security contact is configured, do not include real secrets, invitation links, or conversations in a public issue. Create a minimal report without sensitive data and ask the repository owner for a private communication channel.
