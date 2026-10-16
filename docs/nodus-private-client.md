# Nodus private client

The private frame is selected by `private=nodus`, with credential-free call/room/generation/parent/channel descriptors. It bypasses the ordinary public App and its automatic public-token/session recovery. The existing public and NEON paths remain unchanged.

The parent must implement `nodus-private-room-v1` frame messages with exact origin/source and tuple matching. The frame asks for a new opaque session for each full join; Nodus obtains it server-side using its current membership/session authority. The selected MEET key and LiveKit JWT stay server-side. Existing `buildIceServers()` output is released only with the authorized private session, so this adapter reuses the configured TURN service.

The browser uses the pinned SDK in dual-peer/v0 mode and a private-only WebSocket constructor. Only `/api/private/livekit/rtc` at the exact MEET origin is accepted. The fixed non-secret SDK sentinel is removed from the URL; the real opaque handle is carried in `Sec-WebSocket-Protocol`. Partial resume is refused; the private app obtains a fresh session and full join after transport loss. It does not persist the opaque handle, key, JWT or active call in storage.

The parent owns Leave and End controls. Private VideoRoom does not show a public room code or suggest sharing one. Parent Leave receives an acknowledgement after the shared room disconnect completes. The local loopback fixture demonstrated ended microphone/camera tracks and closed signaling. Real screen-share and two-device TURN acceptance remain release requirements.

Run API `test:nodus` only after the API is built and frontend exact dependencies installed; it now includes actual generated-protocol compatibility checks. Local evidence additionally includes full frontend TypeScript/build and actual SDK2.22.3/protocol1.50.4 in an Edge155 loopback using synthetic media. These do not replace native API SQLite tests or production activation checks. Install this with the reviewed lifecycle correction before activation; do not deploy the earlier window/device revocation behavior.

## Connecting Nodus

Nodus connects with only MEET's address and one MEET API key with write access, entered in Nodus Settings → Connections → MEET calls. With that key, Nodus calls `POST /api/integrations/nodus/identity`, which answers the key's ID and whether MEET selected it; only for the selected key does it also answer the Nodus address MEET checks with and MEET's public address.

To select the key, open **Admin → API Keys → Nodus calls**, choose the key and enter the Nodus address, and save. It applies at once, without a restart. To rotate the key, use **Rotate** on it (a new value under the same ID, so nothing changes in MEET) and enter the new value in Nodus Settings → MEET calls → Replace API key. To use a different key, create it, choose it under Nodus calls, then enter it in Nodus.

A saved choice wins. Without one, MEET falls back to two server values in `deploy/external-proxy/nodus.env` (not tracked; neither value is a secret), applied by recreating the API with `docker compose up -d --no-deps meet-api`:

```
NODUS_INTEGRATION_KEY_ID=<the key ID Nodus Settings shows>
NODUS_ORIGIN=https://nodus.example.com
```

`PUBLIC_BASE_URL` must be MEET's https address. Until a key and the Nodus address are chosen and the key has write or admin permission, private rooms stay unavailable and Nodus shows "Waiting for MEET"; the Nodus calls section says what is missing.

