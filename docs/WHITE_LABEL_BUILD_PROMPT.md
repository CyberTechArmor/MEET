# Build prompt: self-hosted video conferencing platform ({{PRODUCT_NAME}})

> **How to use this file.** Copy everything below the horizontal rule into a new
> Claude Code session (or keep it in the new repo as `docs/BUILD_SPEC.md` and
> say "implement docs/BUILD_SPEC.md, phase 1"). Before you do, find-and-replace
> the four placeholders:
>
> | Placeholder | Meaning | Example |
> |---|---|---|
> | `{{PRODUCT_NAME}}` | Display name shown in the UI, docs, OpenAPI title, WebAuthn RP name | `Acme Connect` |
> | `{{product_slug}}` | Lowercase, no spaces. Used for storage keys, DB filename, compose service names, package names | `acme-connect` |
> | `{{ENV_PREFIX}}` | Upper-case prefix for product-specific env vars | `ACME` |
> | `{{KEY_PREFIX}}` | Short prefix on generated API keys | `ac` |
>
> Nothing in this spec references the original codebase, its author, or any
> other product. Keep it that way in the generated code: no brand names other
> than `{{PRODUCT_NAME}}` in source, comments, docs, commit messages, or
> container names.

---

## 0. Role, goal, and hard rules

You are building **{{PRODUCT_NAME}}**, a self-hosted, white-label video
conferencing platform for 1-to-1 calls, small group calls, and screen sharing.
It is deployed with Docker Compose on a single host, embeds into third-party
web apps via iframe, exposes a REST API with API keys and signed webhooks, and
ships an admin panel. You are building it **from scratch** in this repository.

Hard rules:

1. **Branding.** The only product name that may appear anywhere is
   `{{PRODUCT_NAME}}` (and `{{product_slug}}` in identifiers). Do not mention
   any other conferencing product, vendor, company, or prior codebase in code,
   comments, docs, UI strings, or commits. Generic technology names (LiveKit,
   coturn, Caddy, nginx, Docker, Incus/LXC) are fine.
2. **Stack is fixed** (Section 2). Do not swap frameworks.
3. **Behavioral parity with this spec is the acceptance bar.** Where the spec
   gives an exact request/response shape, header name, URL parameter, storage
   key, or timeout, implement it exactly; external integrators depend on them.
4. **Everything in Section 9 (hard-won behaviors)** must be honored. Each item
   there is a bug that was found in production and fixed; do not reintroduce.
5. **Work in phases** (Section 11). Finish a phase, run its checks, commit,
   then continue. Do not skip the deployment and docs phases.
6. Ask no questions unless a decision would change the public API surface.
   Otherwise choose sensible defaults and note them in the commit message.

---

## 1. Product overview (what the user gets)

### 1.1 Participant experience

- Open the site, enter a display name. Two buttons: **Create a new room** and
  **Join existing room**. Both disabled until a name is entered.
- Create: a 6-character room code is generated server-side (fallback:
  client-side) from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O,
  L, 0, 1). Shown as `ABC-123` (dash inserted after 3 chars) in a large
  monospace read-only field, with a "New code" link to regenerate and a
  **Copy invite link** button (copies `<origin>/?room=ABC123`, shows
  "Link copied!" for 2 s).
- Join: user types a code; input strips anything not `[A-Z0-9]`, upper-cases,
  caps at 6 chars, and displays formatted. Submit label is "Start Call" for
  create, "Join Call" for join. A "Back" button returns to the two-button
  screen and clears the code.
- Footer text: "No account required. Your data stays private."
- On submit the app fetches a join token, connects to the media server, and
  switches to the room view. Mic and camera are enabled automatically after
  connect (fire-and-forget; see 9.4). Errors are toasts.
- **Room view:**
  - Top-left badge: `Room: ABC-123` with a copy-code button. Fades out with
    the controls.
  - Top-right badge when someone is sharing: green pulsing pill reading
    "Sharing your screen" or "`<name>` is sharing".
  - When alone: centered glass card "Waiting for others to join..." with the
    formatted code in accent color.
  - **Grid layout** driven by the number of *remote* participants (local user
    is in the grid only when alone, otherwise in a picture-in-picture self
    view): 1 tile fills the viewport (no rounding, 80 px reserved at the bottom
    for controls); 2 side-by-side (max 600 px wide each); 3-4 in 2×2; 5-6 in
    3×2; 7+ in a 3-column scrolling grid. Tiles keep 16:9. Mobile (≤640 px)
    stacks vertically and fits to screen without overflow; tablet (641-1024)
    reduces columns; mobile landscape (height ≤500) uses row layouts and a
    4×2 grid for 7+.
  - **Video tile:** shows camera video (local view mirrored with
    `scale-x-[-1]`), otherwise an avatar circle with initials (first letters of
    first two words, else first two chars) on a color chosen by hashing the
    participant identity across 8 Tailwind colors (blue, green, purple, pink,
    yellow, red, indigo, teal). Bottom gradient overlay with the name ("You"
    for local), a red mic-muted badge, and a green "Sharing" chip when that
    participant is screen sharing. Remote tiles render a hidden `<audio>`
    element and attach the remote microphone track to it (see 9.2).
  - **Screen-share layout:** when anyone is sharing, the layout becomes a
    full-width presenter view (`object-contain`, black background, bottom-left
    pill "`<name>`'s screen" / "You's screen" → use "Your screen") with a
    horizontal strip of small 16:9 tiles for everyone (local first) beneath
    it. In mobile landscape the strip becomes a 140 px vertical side column.
    "Last sharer wins": whoever most recently started sharing is shown; when
    they stop, fall back to the local share if active, else any other remote
    sharer, else none.
  - **Self-view PiP** (only when ≥1 remote participant and no screen share):
    224 px-wide 16:9 floating card bottom-right, mirrored video or avatar,
    hover overlay with a minimize button, mic/camera-off badges, and an
    always-visible mic-muted badge top-left. Minimized state is a 56 px round
    button with a hover "expand" icon. It sits 6 rem from the bottom, 7 rem on
    small screens when controls are visible.
  - **Control bar** (bottom center, glass pill): mic toggle, camera toggle,
    screen-share toggle (hidden if `getDisplayMedia` is unavailable, e.g.
    mobile), **pin controls** toggle, then a divider and **Leave call** (red)
    and, for the host only, **End meeting for all** (orange). Leave and End
    each open a confirmation modal (Escape closes; backdrop click cancels;
    body scroll locked). Disabled/off state of mic and camera is red; active
    screen share is green with a pulsing dot. When the URL had
    `hideEndCall=true`, the divider, Leave, and End buttons are not rendered.
  - **Auto-hide:** controls and the room badge fade out after 3 s of no mouse
    movement, reappear on movement, stay visible while hovered, and never hide
    when pinned.
  - Connecting shows a spinner and "Connecting to room..."; reconnecting shows
    an amber spinner "Reconnecting..." / "Please wait".
  - Toasts (top-center, dark, 3 s): "Connected!", "Reconnecting...",
    "Disconnected from room", "`<name>` joined", "`<name>` left" (👋),
    "Meeting ended for all participants", "Microphone unavailable" (🔇),
    "Camera unavailable" (📷), "Camera/microphone permission denied. Please
    allow access and try again.", "Only the host can end the meeting",
    "Failed to toggle microphone/camera/screen share", "Media error: …".
- **Refresh rejoin:** on page load, if there is a saved session (see 5.4) the
  app reconnects automatically with the saved name and room.
- **Public access disabled** screen (when the admin has turned public access
  off): product name, red "off" icon, "Public Access Disabled", explanatory
  copy, an info box noting API access with keys still works, and the admin
  gear button. The admin panel remains reachable.
- A small semi-transparent **gear button** bottom-right on the join screen
  opens the admin panel.

### 1.2 Join links and embed contract (public, must not change)

Query parameters on the site root:

| Param | Type | Behavior |
|---|---|---|
| `room` | string | Pre-fills the code (sanitized as above). Presence switches the form into join mode. |
| `name` | string ≤50 | Pre-fills the display name. |
| `autojoin` | `true`/`1`/`false`/`0` | Defaults to **true when `name` is present**. When room + name + autojoin, connect immediately without showing the form. |
| `quality` | `auto`\|`high`\|`max`\|`balanced`\|`low` | Sets the client video quality preset before connecting. Invalid values ignored. |
| `hideEndCall` | `true`/`1` | Hides Leave/End buttons (host page manages lifecycle). |

After parsing, the app removes the query string with `history.replaceState`
(URL is cleaned, form stays pre-filled). The `#admin` hash is separate (6.6).

Iframe embed:

```html
<iframe src="https://{{product_slug}}.example.com/?room=ROOM&name=NAME&hideEndCall=true"
        allow="camera; microphone; display-capture; autoplay" allowfullscreen
        style="width:100%;height:600px;border:none"></iframe>
```

### 1.3 Operator experience (admin panel)

Full-screen overlay with header (title "Admin Panel", API version, live
connection indicator, Refresh, Logout, close ×) and tabs **Dashboard,
Settings, API Keys, Webhooks, Docs**. Details in Section 6.7.

### 1.4 Integrator experience

REST API (Section 4), API keys with `X-API-Key`, signed webhooks, OpenAPI
served by the API and rendered with Swagger UI inside the admin panel, an
iframe integration guide (rendered in the panel, downloadable as Markdown,
and shipped as `docs/IFRAME_INTEGRATION.md`).

---

## 2. Architecture and stack

```
Browser ──REST──▶ API (Express 5 + TypeScript, Node 20, SQLite)
   │                │ livekit-server-sdk (RoomServiceClient, AccessToken)
   └──WebSocket/WebRTC──▶ LiveKit server (SFU, Go, official image)
                          UDP media bypasses any reverse proxy
                    coturn (optional TURN/STUN relay, profile-gated)
Reverse proxy (bundled Caddy | host nginx | external manager | none) in front.
```

| Layer | Choice (pin these majors) |
|---|---|
| Frontend | React 19, TypeScript 5, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`, CSS-first `@theme`), Zustand 5 (+ `persist`), `livekit-client` 2.x, `react-hot-toast` 2.x, `@simplewebauthn/browser` 13.x (lazy-imported) |
| API | Node 20, Express 5, TypeScript 5 (`tsc` build, `tsx watch` dev), `cors`, `ws` 8, `livekit-server-sdk` 2.x, `better-sqlite3` 11 (WAL), `@simplewebauthn/server` 13.x, Node `crypto.scrypt` for passwords (no bcrypt) |
| Media | `livekit/livekit-server:latest`, `coturn/coturn:latest` |
| Containers | Multi-stage Dockerfiles (node:20-alpine → nginx:alpine for the frontend; node:20-alpine → node:20-alpine for the API), Docker Compose v2 |
| Proxy | Caddy 2 (bundled mode), nginx (host mode + reference snippets), reference Caddyfiles for external proxies |

Fonts: Google Fonts **Outfit** (display) and **IBM Plex Sans** (body), loaded
from `<head>` with preconnect. Favicon: an SVG icon on a `#0a0a0a` rounded
square with an accent gradient glyph (design your own glyph; keep the palette).

Design tokens (Tailwind `@theme` in `index.css`, prefix `--color-{{product_slug}}-…`
or a short alias of your choice; keep the values):

```
bg #0a0a0a · bg-secondary #111111 · bg-tertiary #1a1a1a · bg-elevated #222222
accent #00d4ff · accent-dark #00a8cc · accent-light #4de5ff · accent-subtle rgba(0,212,255,.1)
success #10b981 · warning #f59e0b · error #ef4444
text-primary #fff · text-secondary rgba(255,255,255,.7) · text-tertiary .5 · text-disabled .3
border rgba(255,255,255,.1)
shadow-glow 0 0 20px rgba(0,212,255,.3) · shadow-soft 0 4px 30px rgba(0,0,0,.3)
```

Utilities: `.glass` (rgba(26,26,26,.8) + 16 px backdrop blur + 1 px border),
`.transition-smooth` (200 ms cubic-bezier(.4,0,.2,1)), `.pulse-glow`
(green box-shadow pulse 2 s), `.animate-scale-in` (200 ms), `.animate-fade-in`
(300 ms), `.controls-container/.controls-hidden` (opacity + translateY(20px)
300 ms, pointer-events none when hidden), custom 8 px dark scrollbar, cyan
focus ring, cyan selection. Theme is dark-only.

---

## 3. Repository layout

```
/
├── README.md                    # product README (Section 10)
├── API.md                       # full REST + client SDK reference
├── ARCHITECTURE.md              # components, data flow, known limitations
├── docs/
│   ├── IFRAME_INTEGRATION.md
│   └── install/external-reverse-proxy.md
├── install.sh                   # interactive installer (Section 7.6)
├── update.sh                    # pull + rebuild + restart, preserves state
├── cleanup.sh                   # remove containers/images/volumes/config
├── diagnose.sh                  # collect logs/ports/health for support
├── .env.example
├── docker-compose.yml           # mode 1: demo
├── docker-compose.proxy.yml     # mode 2: bundled Caddy + ACME
├── docker-compose.nginx.yml     # mode 3: host nginx + certbot
├── docker-compose.subdomains.yml  # mode 4: external proxy manager, 3 subdomains
├── Caddyfile                    # for mode 2
├── nginx.{{product_slug}}.conf  # template for mode 3
├── livekit.yaml                 # for modes 1-4
├── deploy/external-proxy/       # mode 5: behind an existing host proxy (LXC/bare-metal)
│   ├── .env.example
│   ├── docker-compose.yml
│   ├── livekit.yaml.template
│   ├── turnserver.conf.template
│   ├── caddy/{single-domain,three-domain}.Caddyfile
│   ├── nginx/{single-domain,three-domain}.conf
│   ├── info.sh                  # port map, proxy wiring, firewall list, probes
│   ├── mount-cert.sh            # bind-mount host cert dir into the LXC (runs on the Incus host)
│   └── reset-admin.sh           # wrapper for the API's reset-admin CLI
├── .github/workflows/external-proxy.yml   # CI: build + healthy + ports on 0.0.0.0
├── api/
│   ├── Dockerfile, package.json, tsconfig.json, openapi.yaml (static copy of the spec)
│   └── src/{index.ts, db.ts, store.ts, types.ts, auth.ts, webauthn.ts, reset-admin.ts}
└── frontend/
    ├── Dockerfile, nginx.conf, index.html, vite.config.ts, package.json, tsconfig*.json
    ├── public/{{product_slug}}-icon.svg
    └── src/
        ├── main.tsx, App.tsx, index.css
        ├── components/{JoinForm,VideoRoom,VideoTile,ScreenShareView,ControlBar,
        │               SelfViewPip,ParticipantOverlay,ConfirmModal,AdminPanel}.tsx
        ├── hooks/{useLiveKit,useMediaDevices}.ts
        ├── stores/{roomStore,adminStore}.ts
        └── lib/client.ts        # API calls, quality presets, join links, session, admin API
```

You may split `index.ts` and `AdminPanel.tsx` into more files; keep the public
behavior identical.

---

## 4. Backend specification (`api/`)

### 4.1 Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP + WS listen port |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | Must match the LiveKit server's key pair |
| `LIVEKIT_URL` | `http://localhost:7880` | LiveKit HTTP API for RoomServiceClient |
| `CORS_ORIGIN` | `*` | `*`, a single origin, or comma-separated list. `credentials: true` only when not `*`. Methods GET/POST/PUT/DELETE/OPTIONS; allowed headers `Content-Type, Authorization, X-API-Key`. |
| `{{ENV_PREFIX}}_ADMIN_USERNAME` / `{{ENV_PREFIX}}_ADMIN_PASSWORD` | unset | If **both** set, they are the admin credentials (password hashed fresh at boot, never persisted). Otherwise DB credentials are used; if none, first-login mode. |
| `{{ENV_PREFIX}}_DATA_DIR` | `/data` | SQLite location: `<dir>/{{product_slug}}.db` |
| `PUBLIC_BASE_URL` | empty | Public origin of the frontend. Required for passkeys (rpID = hostname, origin allow-list). |
| `PUBLIC_API_URL`, `PUBLIC_LIVEKIT_URL` | empty | Three-domain mode; added as extra WebAuthn origins. |
| `TURN_ENABLED` | `false` | When `true` and the four below are set, `/api/token` returns `iceServers`. |
| `TURN_DOMAIN`, `TURN_USERNAME`, `TURN_PASSWORD`, `TURN_TLS_PORT` (5349), `TURN_UDP_PORT` (3478) | | |

`API_VERSION = '1.0.0'`; record process start time for uptime.

### 4.2 Persistence (`db.ts`, `store.ts`, `types.ts`)

SQLite via better-sqlite3, opened once at startup, pragmas
`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`. Forward-only
migrations tracked in a single-row `schema_version` table, each run inside a
transaction, logging `[db] migrated to schema vN`. Final schema:

```sql
api_keys(id TEXT PK, name, key, key_hash, permissions TEXT/*JSON array*/, created_at ISO, last_used_at ISO NULL)
  + index on key_hash
webhooks(id TEXT PK, name, url, events TEXT/*JSON*/, enabled INT, secret, created_at, last_triggered_at NULL, failure_count INT DEFAULT 0)
settings(key TEXT PK, value TEXT/*JSON*/)            -- single row key='server'
admin_credentials(id INT PK CHECK(id=1), username DEFAULT '', password DEFAULT '' /*legacy, always cleared*/,
                  first_login_done INT DEFAULT 0, password_hash TEXT DEFAULT '', user_handle BLOB NULL)
  + seed row id=1
admin_sessions(token TEXT PK, created_at, expires_at) + index on expires_at
webauthn_credentials(id TEXT PK, credential_id BLOB UNIQUE, public_key BLOB, counter INT DEFAULT 0,
                     transports TEXT DEFAULT '[]', label TEXT DEFAULT '', created_at, last_used_at NULL)
  + index on credential_id
```

Implement it as three migrations (v1 keys/webhooks/settings/credentials, v2
sessions + password_hash, v3 passkeys) so the migration mechanism is
exercised. `store.ts` exposes typed CRUD (list/get/find-by-hash/save
(upsert)/delete/count for keys and webhooks; load/save settings;
load/save admin credentials incl. a raw variant; list/find/save/delete/
deleteAll passkeys; get/save/delete/purgeExpired sessions). Dates are
rehydrated as `Date` objects. `user_handle` is minted lazily as 16 random
bytes on first read and **never changed afterwards** (changing it invalidates
every registered passkey).

Persisted settings shape:

```ts
{ publicAccessEnabled: boolean /*true*/, maxParticipantsPerMeeting: number /*0=unlimited*/,
  maxConcurrentMeetings: number /*0*/, iframeAllowedDomains: string[] /*[]=allow all*/,
  defaultVideoQuality: 'auto'|'high'|'max'|'balanced'|'low' /*'auto'*/ }
```

On boot: load, merge over defaults (so older blobs gain new fields), save
back if nothing was stored. Keep an in-memory hot copy (it is read on every
request by the CSP middleware) and persist on every mutation. Add two derived,
non-persisted fields `recommendedMaxParticipants` and
`recommendedMaxMeetings`: assume 4 GB RAM and 100 Mbps, ~100 MB and ~3 Mbps
per participant, cap participants at 50, meetings = max(5, participants/10).
(Result: 33 participants, 5 meetings.)

Transient in-memory `roomMetadata: Map<roomName, { displayName, createdAt, videoQuality? }>`.

### 4.3 Passwords, sessions, auth middleware (`auth.ts`, `index.ts`)

- `hashPassword` → `"<saltHex>$<scryptHex>"` with 16-byte salt, keylen 64,
  Node default scrypt params. `verifyPassword` uses `timingSafeEqual`.
- On boot, lazily migrate a legacy plaintext `password` column into
  `password_hash` and clear it.
- Credential resolution priority: env pair → DB pair → first-login mode.
- Session tokens: 32 random bytes hex, 24 h expiry, stored in
  `admin_sessions` (so a container restart does not log the admin out).
  Purge expired sessions after each login.
- Generated identifiers: ids = 12 random bytes hex; API key =
  `{{KEY_PREFIX}}_` + 24 random bytes hex; webhook secret = `whsec_` + 24
  random bytes hex. Keys are stored **both** raw (for masking in lists) and as
  SHA-256 hex (`key_hash`) which is what lookups use.
- Masking: API key → first 11 chars + `...` + last 4; secret → first 9 + `...` + last 4.
- Two middlewares:
  - `authenticateAdmin`: accepts `X-API-Key` (valid key → `req.apiKey`,
    `req.isAdmin = permissions.includes('admin')`, update `last_used_at`;
    invalid → 401 `{error:'Invalid API key'}`), else `Authorization: Bearer
    <token>` where token is a live session **or the plain admin password**
    (verified against the hash). Otherwise 401 `{error:'Unauthorized'}`.
  - `authenticateApiKeyOrAdmin`: same, but any valid API key passes.
- CSP middleware on every response: `Content-Security-Policy: frame-ancestors
  *` when `iframeAllowedDomains` is empty, else `frame-ancestors 'self'
  <domains joined by space>`; always `removeHeader('X-Frame-Options')`.

### 4.4 Endpoints

All errors are JSON `{ error: string }`. Room names are sanitized with
`replace(/[^a-zA-Z0-9-_]/g,'').slice(0,50)`; participant names `slice(0,50)`;
device ids `replace(/[^a-zA-Z0-9_-]/g,'').slice(0,30)`.

**Public**

| Method & path | Behavior |
|---|---|
| `GET /health` | `{ status:'ok', timestamp, version }` |
| `GET /api/status` | `{ publicAccessEnabled, defaultVideoQuality, version }` |
| `GET /api/docs` | The OpenAPI 3.0.3 document as JSON (Section 4.8). Also serve the same document at `GET /api/openapi.yaml` as YAML if convenient; the panel uses `/api/docs`. |
| `GET /api/room-code` | `{ roomCode }` 6 chars from the safe alphabet |
| `POST /api/token` | Body `{ roomName, participantName, deviceId? }`. If no `X-API-Key` header **and** `publicAccessEnabled` is false → 403 `"Public access is currently disabled. Please use API key authentication."`. Validate (400 `roomName is required` / `participantName is required` / `Invalid room name`). Identity = `${name}_${deviceId}` or `${name}_${Date.now()}`. List rooms via RoomServiceClient; `isNewRoom` = not found; `isHost` = new room **or** existing room has 0 participants; if listing fails, assume host + new. Enforce `maxConcurrentMeetings` for new rooms and `maxParticipantsPerMeeting` for existing ones → 503 `{ error, limit, current }`. Mint a LiveKit `AccessToken` with `identity`, `name`, grant `{ room, roomJoin:true, canPublish:true, canSubscribe:true, canPublishData:true, roomAdmin:isHost }`. Fire webhooks `room.created` (new rooms) and `participant.joined` `{ roomName, participantName, participantIdentity, isHost }`. Respond `{ token, roomName, participantName, participantIdentity, isHost, quality, iceServers? }` where `quality` = room override ?? `defaultVideoQuality`, and `iceServers` is present only when TURN is configured: `[{ urls:[ 'turns:<d>:<tls>?transport=tcp', 'turn:<d>:<udp>?transport=udp', 'turn:<d>:<tls>?transport=tcp' ], username, credential }]`. |
| `POST /api/end-meeting` | Body `{ roomName, participantIdentity }` → `roomService.deleteRoom`; webhook `room.deleted { roomName, endedBy }`; `{ success:true, message:'Meeting ended for all participants' }`. (No server-side host check today; document this as a known limitation.) |

**Admin auth**

| | |
|---|---|
| `POST /api/admin/login` | Body `{ username, password }` (400 if missing). In first-login mode the supplied pair **becomes** the account (hash + persist, `firstLoginDone=1`). Then verify; 401 `Invalid username or password`. Respond `{ success:true, token, expiresAt, isFirstLogin, username }`. |
| `POST /api/admin/logout` (admin) | Delete the bearer session. `{ success:true }` |
| `GET /api/admin/webauthn/status` (public) | `{ configured, registeredCount }` |
| `POST /api/admin/webauthn/register/options` (admin) | `{ ticket, options }` from `generateRegistrationOptions` (rpName `{{PRODUCT_NAME}}`, rpID, userID = user_handle, userName = admin username or `admin`, attestation `none`, exclude existing credentials, `residentKey:'preferred'`, `userVerification:'preferred'`). Challenges live in an in-memory map keyed by a 16-byte hex ticket with a 5-minute TTL and a `kind` (`register`/`auth`); consumed once. 503 when `PUBLIC_BASE_URL` is unset. |
| `POST /api/admin/webauthn/register/verify` (admin) | Body `{ ticket, label?, response }` → verify (origin list, rpID, `requireUserVerification:false`), store passkey (label ≤100, default `Passkey`). `{ success:true, id, label }`. 400 on expired ticket/failed verification. |
| `POST /api/admin/webauthn/auth/options` (public) | 404 `No passkeys registered` if none; else `{ ticket, options }` with `allowCredentials`. |
| `POST /api/admin/webauthn/auth/verify` (public) | Verify assertion, bump counter + `last_used_at`, issue a session exactly like password login. 401 on unknown passkey/failed assertion. |
| `GET /api/admin/webauthn/credentials` (admin) | `{ credentials:[{ id,label,transports,createdAt,lastUsedAt }] }` |
| `DELETE /api/admin/webauthn/credentials/:id` (admin) | `{ success:true }` or 404 |

**Admin data**

| | |
|---|---|
| `GET /api/admin/stats` (key or admin) | `{ activeRooms, totalParticipants, apiKeysCount, webhooksCount, uptime /*s*/, version }`. If LiveKit is unreachable, return zeros for the first two rather than 500. |
| `GET /api/admin/settings` (admin) | `{ settings:{…5 fields}, recommendations:{ maxParticipantsPerMeeting, maxConcurrentMeetings }, videoQualityOptions:[…] }` |
| `PUT /api/admin/settings` (admin) | Partial body. Negative limits → 400. `iframeAllowedDomains` filtered to entries matching `/^(\*\.)?[\w.-]+\.[a-z]{2,}$/i` or `/^https?:\/\/[\w.-]+/i`. Invalid `defaultVideoQuality` → 400 listing valid values. Persist. `{ success:true, settings }` |
| `GET /api/rooms` (key or admin) | `{ rooms:[{ name, displayName\|null, numParticipants, createdAt (from LiveKit `creationTime` seconds → ISO) \| null, maxParticipants }], total }` |
| `POST /api/rooms` (key or admin) | Body `{ roomName, displayName?, maxParticipants? (100), emptyTimeout? (300 s), quality? }`. Validate quality (400), name (400 `Invalid room name. Use alphanumeric characters, hyphens, or underscores.`), 409 `{ error:'Room already exists', roomName }`. `roomService.createRoom`. Store metadata if displayName or quality given. Webhook `room.created { roomName, displayName }`. 201 `{ success:true, room:{ name, displayName\|null, maxParticipants, emptyTimeout, createdAt }, joinUrl:'<proto>://<host>/?room=<name>' }` (derive from the request). |
| `PUT /api/rooms/:roomName` (key or admin) | Body `{ displayName? }`; 404 if LiveKit has no such room; update metadata; respond the room info object. |
| `GET /api/admin/api-keys` (admin) | `{ apiKeys:[{ id, name, keyPrefix /*masked*/, permissions, createdAt, lastUsedAt }] }` |
| `POST /api/admin/api-keys` (admin) | `{ name, permissions?=['read'] }`; permissions filtered to `read|write|admin`; name ≤100. 201 `{ id, name, key /*full, once*/, permissions, createdAt }` |
| `DELETE /api/admin/api-keys/:keyId` (admin) | `{ success:true, message:'API key revoked' }` / 404 |
| `POST /api/admin/api-keys/:keyId/rotate` (admin) | New secret, same id/name/permissions/createdAt, `lastUsedAt` reset. `{ id, name, key, permissions, createdAt }` / 404 |
| `GET /api/admin/webhooks` (admin) | `{ webhooks:[{ id,name,url,events,enabled,secret /*masked*/,createdAt,lastTriggeredAt,failureCount }] }` |
| `POST /api/admin/webhooks` (admin) | `{ name, url, events, enabled?=true }`; validate URL with `new URL`; events filtered to the known set, 400 `No valid events provided` if none. 201 with the **full** secret. |
| `GET/PUT/DELETE /api/admin/webhooks/:id` (admin) | Get (masked), partial update with the same validation, delete `{ success:true, message:'Webhook deleted' }`. |
| `POST /api/admin/webhooks/:id/test` (admin) | POST a payload `{ id, type:'test', timestamp, data:{ message:'This is a test webhook event' } }` with the standard headers, 10 s timeout. Always 200: `{ success, statusCode (0 on network error), responseTime ms, error\|null }`. |

### 4.5 Webhook dispatcher

Events: `room.created`, `room.deleted`, `participant.joined`,
`participant.left`, `recording.started`, `recording.stopped` (the last three
are reserved: accepted in subscriptions, not emitted yet). Payload
`{ id, type, timestamp, data }`. For each enabled webhook subscribed to the
event: POST JSON with headers `X-Webhook-Signature: <hex HMAC-SHA256 of the
exact JSON body using the webhook secret>`, `X-Webhook-Event`,
`X-Webhook-Id`; 10 s timeout via `AbortSignal.timeout`. Update
`lastTriggeredAt`; on non-2xx or error increment `failureCount`, on success
reset it to 0; persist. Dispatch is fire-and-forget from request handlers.

### 4.6 Admin WebSocket (`/ws/admin`)

`ws` server attached to the same HTTP server. On connect send
`{ type:'auth_required' }`. Client sends `{ type:'auth', token }` where token
is a session token or the admin password; success → add to the authenticated
set and send `{ type:'init', data, timestamp }`; failure → `{ type:'error',
error:'Invalid token' }` and close. `{ type:'refresh' }` → `{ type:'update',
data }`. Every 5 s, if any clients are connected, broadcast `update` to all.
`data` = `{ stats, rooms, apiKeys (masked), webhooks (masked) }` with the same
shapes as the REST endpoints. Invalid JSON → `{ type:'error', error:'Invalid
message' }`.

### 4.7 Startup banner

Print a boxed banner with version, port, CORS origin, LiveKit status, admin
mode (`User: <name>` or `First login sets credentials`), WS URL, docs URL.

### 4.8 OpenAPI document

Embed an OpenAPI 3.0.3 object in code (title `{{PRODUCT_NAME}} Video
Conferencing API`, description covering auth methods and webhooks, tags
Public / Admin / Rooms / API Keys / Webhooks / Passkeys, `servers:[{url:'/'}]`,
security schemes `bearerAuth` (http bearer) and `apiKeyAuth` (header
`X-API-Key`)). Document every route above with request/response schemas and
the enums. Also keep `api/openapi.yaml` in sync as a static file.

### 4.9 Recovery CLI (`reset-admin.ts` → `node dist/reset-admin.js`)

Flags: `--set-password [PASSWORD]` (prompt with `*` echo on a TTY, else read
one stdin line; refuse empty or <8 chars), `--clear-passkeys`,
`--clear-sessions`, `--bootstrap` (back to first-login mode),
`--reset-all`, `--help`. Prints `✓ <what it did>` lines. Runs against the
same DB file; no API restart needed. `deploy/external-proxy/reset-admin.sh`
wraps `docker compose exec <api-service> node dist/reset-admin.js "$@"` and
defaults to `--reset-all` with no args. Add npm script `reset-admin`.

---

## 5. Frontend client library (`src/lib/client.ts`)

### 5.1 URL detection

```
API_URL:     VITE_API_URL if non-empty; else '' (relative) when page port is ''/80/443; else `${protocol}//${hostname}:8080`
LIVEKIT_URL: VITE_LIVEKIT_URL if non-empty; else `${wss|ws}://${hostname}/livekit` on 80/443; else `${ws}://${hostname}:7880`
ADMIN_WS:    `${wss|ws}://${hostname}/ws/admin` on 80/443; else `${ws}://${hostname}:8080/ws/admin`
OPENAPI_URL: always absolute (`API_URL || window.location.origin`) + '/api/docs'  (needed inside srcDoc iframes)
```

`vite.config.ts` defines `process.env` as `{}` and listens on 5173 / all hosts.

### 5.2 Video quality presets

```ts
type VideoQualityPreset = 'auto'|'high'|'max'|'balanced'|'low'
max:      capture h2160, simulcast [h360,h720,h1080], vp9, screen h1080fps30
high:     capture h1080, simulcast [h360,h540,h720],  vp9, screen h1080fps30
auto:     capture h1080, simulcast [h180,h540,h1080], vp9, screen h1080fps30   // default
balanced: capture h720,  simulcast [h180,h360],       vp8, screen h720fps15
low:      capture h360,  simulcast [h90,h180],        vp8, screen h720fps5
all: audio dtx=true, red=true
```

Module-level current preset (default `auto`) with `set/getVideoQualityPreset`,
`getQualityConfig(preset?)`, `getAvailableQualityPresets()` returning
`{ preset, name ('4K Ultra HD','Full HD','Adaptive','HD','Low Bandwidth'), description, resolution }`.

`createRoom(preset?)` builds a LiveKit `Room` with: `adaptiveStream:true`,
`dynacast:true`, `videoCaptureDefaults:{ resolution, facingMode:'user' }`,
`publishDefaults:{ videoSimulcastLayers, videoCodec, screenShareEncoding:
preset.encoding, screenShareSimulcastLayers:[h720fps15,h1080fps15], dtx, red,
forceStereo:false, simulcast:true, backupCodec:{ codec:'vp8', encoding:
VideoPresets.h720.encoding } }`, `audioCaptureDefaults:{ autoGainControl,
echoCancellation, noiseSuppression: true }`, `disconnectOnPageLeave:true`.

### 5.3 Device identity

`getDeviceId()` returns a localStorage value under `{{product_slug}}_device_id`,
generating `${Date.now().toString(36)}_${random base36 7 chars}` on first use.

### 5.4 Session persistence

`saveSession(roomCode, displayName, isHost)` writes `{ roomCode, displayName,
timestamp, isHost }` to **sessionStorage** key `{{product_slug}}_session`;
`getSavedSession()` returns it if younger than 1 hour (else clears);
`clearSession()`.

### 5.5 Join links

`parseJoinLink()`, `generateJoinLink({ room, name?, autojoin?, quality? })`
(sets `autojoin=true` automatically when a name is given unless `false`),
`getJoinLink(code)`, `hasJoinLinkParams()`, `clearJoinLinkParams()`,
`formatRoomCode`, `parseRoomCode` exactly as in 1.2.

### 5.6 API wrappers

`getToken`, `generateRoomCode` (client fallback), `getPublicStatus` (defaults
to enabled on failure), `endMeetingForAll`, `adminLogin/Logout`,
`getServerStats`, `listRooms`, `updateRoomDisplayName`, `listApiKeys`,
`createApiKey`, `revokeApiKey`, `listWebhooks`, `createWebhook`,
`updateWebhook`, `deleteWebhook`, `testWebhook`, `getServerSettings`,
`updateServerSettings`, passkey helpers (`getPasskeyStatus`,
`registerPasskey(token,label)`, `signInWithPasskey()`,
`listRegisteredPasskeys`, `deleteRegisteredPasskey`,
`browserSupportsPasskeys()`), and `WEBHOOK_EVENTS`. Every wrapper that gets a
**401** dispatches `window.dispatchEvent(new CustomEvent('admin:unauthorized'))`
so the panel can log out and show "Your session expired or the server
restarted. Please sign in again." Errors throw `Error(body.error || fallback)`.
`@simplewebauthn/browser` is dynamically imported so it stays out of the main
bundle.

---

## 6. Frontend application

### 6.1 State (`roomStore.ts`, Zustand, not persisted)

`view:'join'|'room'`, `displayName`, `roomCode`, `room`, `connectionState`,
`localParticipant`, `remoteParticipants[]` (add dedupes by identity),
`isMicEnabled`(true), `isCameraEnabled`(true), `isScreenSharing`,
`activeScreenShareIdentity`, `isHost`, `controlsVisible`(true),
`controlsPinned`, `hideEndCall`, `reset()`, `resetKeepingName()`.

### 6.2 `useLiveKit` hook

Singleton `sharedRoomInstance` at module scope (see 9.1). `connect(code,
name)`: set Connecting → `getToken` → apply server `quality` via
`setVideoQualityPreset` → set host/code → `createRoom()` → wire events →
`room.connect(LIVEKIT_URL, token, iceServers ? { rtcConfig:{ iceServers } } :
undefined)` → **immediately** set room/local/remote participants and
`view='room'` → `saveSession` → enable mic and camera with `.then/.catch`
(not awaited). Event wiring: ConnectionStateChanged (toasts), Participant
Connected/Disconnected (store + toasts), Track Subscribed/Unsubscribed/
Muted/Unmuted/Published/Unpublished → refresh remote list and maintain
`activeScreenShareIdentity` with last-wins + fallback logic, LocalTrack
Published/Unpublished → mic/camera/screen flags, TrackMuted/Unmuted for the
**local** participant only → flags, Disconnected → clearSession, null the
singleton, `resetKeepingName`, `view='join'`, MediaDevicesError → toast.
Also `disconnect()`, `toggleMic/Camera/ScreenShare` (a cancelled share picker
"Permission denied" is silently ignored), `endMeeting()` (host only).

### 6.3 `useMediaDevices` hook

Enumerate audio/video inputs and outputs with fallback labels, `hasPermission`
inferred from non-empty labels, `requestPermissions()` (getUserMedia then
stop tracks), refresh on `devicechange`. (Present for a future settings UI.)

### 6.4 `App.tsx`

Shows a spinner while `GET /api/status` is in flight (assume enabled on
error). Handles join-link params and saved-session rejoin **once** (ref
guard). Renders JoinForm or VideoRoom, the gear button on the join view, the
public-access-disabled screen, and the AdminPanel overlay.

### 6.5 Components

As described in Section 1.1. `VideoTile` subscribes to the participant's
Track* and LocalTrack* events and forces a re-render; attaches/detaches
camera, screen-share, and (remote only) audio tracks in effects keyed on the
track object. `SelfViewPip` re-attaches when minimized state or camera state
changes. `ConfirmModal` renders through a portal on `document.body`.

### 6.6 Admin panel routing

`#admin` opens the panel on the dashboard; `#admin/<tab>` selects
`settings|api-keys|webhooks|docs`. `showAdmin` and the active tab are mirrored
into the hash with `replaceState` and react to `hashchange`, so refresh and
back/forward keep the panel and tab (see 9.8). Closing the panel restores
`pathname + search`.

### 6.7 Admin panel (`AdminPanel.tsx`, `adminStore.ts`)

`adminStore` (Zustand + `persist` under localStorage key
`{{product_slug}}-admin-store`, persisting only `token`, `expiresAt`,
`isAuthenticated`) also holds stats, apiKeys, webhooks, rooms, loading,
error, `isSessionValid()`.

- **Login card:** username + password, error box, "Login". Copy: "Enter your
  admin credentials to access the admin panel. If this is your first login,
  the credentials you enter will be set as the admin account." If passkeys
  are configured, at least one is registered, and the browser supports
  WebAuthn: an "or" divider and **Sign in with passkey** button.
- **Data loading:** initial load via four parallel REST calls (stats, rooms,
  keys, webhooks). Then open the admin WebSocket; on `update` messages patch
  the store. Retry up to 3 times with backoff `min(5s×n, 15s)`; after that
  fall back to REST polling every 5 s. Header indicator: Live (green), Polling
  (blue), Connecting… (yellow), Disconnected (red). "Refresh" sends
  `{type:'refresh'}` or falls back to REST. Logout closes the socket and
  timers, calls `/api/admin/logout`, clears the store.
- **Dashboard:** four stat cards (Active Rooms, Total Participants, API Keys,
  Uptime as `Xh Ym`) and an Active Rooms list: formatted code, display name
  in quotes or an "Add name" inline editor (Enter saves, Escape cancels, ✓/✕
  buttons), "N participant(s)", **Copy Join Link** (turns green "Copied!" for
  2 s) and **Join** (opens the join link in a new tab).
- **Settings:** Public Access toggle with status line ("Enabled - Anyone can
  use the public interface" / "Disabled - API access only"); Participants per
  Meeting and Concurrent Meetings each with a select Unlimited / Recommended
  (N) / Custom plus a number input when > 0 and a "Current: …" line; Default
  video quality select (`auto — dynamic (recommended)`, `max — 4K capture,
  highest possible`, `high — 1080p`, `balanced — 720p`, `low — 360p, lowest
  bandwidth`); Iframe Embedding Domains (input + Add, Enter adds, status line
  "Currently allowing all domains (*)" in amber or "Restricting to N
  domain(s)" in green, removable chips, examples box); Passkeys (list with
  label, added/last-used dates, Remove; label input + **Register passkey**;
  notes "Disabled — PUBLIC_BASE_URL not configured." / "This browser does not
  support WebAuthn."); an "About Settings" info card with five bullets
  (take effect immediately for new connections; existing meetings unaffected;
  API access always allowed; 0 = unlimited; iframe domains control CSP
  frame-ancestors). Every change saves immediately.
- **API Keys:** create form (name, checkboxes read/write/admin, default
  read), one-time green box showing the full key with "Copy and dismiss";
  list with name, masked prefix, permission chips, Revoke.
- **Webhooks:** "Create Webhook" button → form (name, URL, event checkboxes,
  Create/Cancel); one-time secret box; list with name, Active/Disabled chip,
  "N failures", Test (alert with response time or error), Enable/Disable,
  Delete, URL, event chips.
- **Docs:** sub-tabs **API Reference** (a `srcDoc` iframe loading Swagger UI
  5.x from a CDN, dark-themed, pointing at the absolute OpenAPI URL, plus a
  bar showing the docs URL and "View JSON") and **Iframe Integration** (a
  rendered guide that detects the deployment type from `VITE_API_URL`:
  subdomain routing when set, path routing otherwise; shows the frontend URL
  and API URL for *this* deployment, a "common mistake: 405 from nginx"
  warning for subdomain mode, quick-start snippets with and without
  `hideEndCall`, the URL parameter table, integration steps, required
  permissions, a JavaScript `Integration` class example, a React example, and
  troubleshooting; **Download as Markdown** builds the same content as a
  `.md` blob named `{{PRODUCT_NAME}}_Iframe_Integration.md`).

---

## 7. Deployment

### 7.1 Frontend image

Build with `npm ci` and `npm run build` (`tsc && vite build`); build args
`VITE_API_URL` and `VITE_LIVEKIT_URL` default **empty** (runtime detection).
Serve with nginx:alpine: gzip, `X-Content-Type-Options nosniff`, **no
`X-Frame-Options`** (embedding is controlled by CSP from the API/proxy),
1-year immutable cache for hashed assets, SPA fallback to `index.html`,
`GET /health` → `OK`. Healthcheck with wget.

### 7.2 API image

Builder installs `python3 make g++ sqlite-dev` (fallback for arches without
better-sqlite3 prebuilds), `npm ci`, `tsc`, `npm prune --omit=dev`; runtime
copies `node_modules` and `dist`, creates `/data` as a `VOLUME`, sets
`{{ENV_PREFIX}}_DATA_DIR=/data`, exposes 8080, healthcheck on `/health`.

### 7.3 LiveKit config (`livekit.yaml`)

`port: 7880`, `rtc.tcp_port: 7881`, UDP `port_range_start/end` (50000-50100
in modes 1-4; 50000-54900 in mode 5), `use_external_ip: true`,
`enable_loopback_candidate: false`, STUN `stun.l.google.com:19302` and
`stun1.l.google.com:19302`, `keys: { devkey: secret }` fallback, logging info.
The container reads `NODE_IP` and `LIVEKIT_KEYS` (`"<key>: <secret>"`) from
the environment; installers must write the same pair to the API env and
`LIVEKIT_KEYS` together (see 9.10).

### 7.4 Compose variants

| Mode | File | Frontend | API | LiveKit | Notes |
|---|---|---|---|---|---|
| 1 Demo | `docker-compose.yml` | `:3000→80` | `:8080` | 7880, 7881, 50000-50100/udp | `CORS_ORIGIN=*`, dev keys |
| 2 Bundled Caddy | `docker-compose.proxy.yml` | expose 80 | expose 8080 | as above + expose 7880 | Caddy 80/443 (+443/udp), volumes `caddy_data`, `caddy_config`, env `{{ENV_PREFIX}}_DOMAIN`, `ACME_EMAIL`, `TLS_MODE` (`tls internal` for IPs) |
| 3 Host nginx | `docker-compose.nginx.yml` | `127.0.0.1:3000` | `127.0.0.1:8080` | `127.0.0.1:7880`, public 7881 + UDP | nginx template with certbot paths, HSTS, `/livekit/` rewrite, `/api/`, `/health`, `/ws/`, catch-all; 24 h WS timeouts |
| 4 Subdomains | `docker-compose.subdomains.yml` | `127.0.0.1:3002`, build args `VITE_API_URL=https://api.<domain>`, `VITE_LIVEKIT_URL=wss://livekit.<domain>` | `127.0.0.1:8080`, `CORS_ORIGIN=https://<domain>` | `127.0.0.1:7880` + public media | For proxy managers without path routing |
| 5 External proxy | `deploy/external-proxy/docker-compose.yml` | `${BIND_HOST:-0.0.0.0}:3000` | `0.0.0.0:8080`, `LIVEKIT_URL=http://host.docker.internal:7880`, `extra_hosts: host-gateway`, named volume `{{product_slug}}-api-data:/data`, all `PUBLIC_*` and `TURN_*` vars passed through, `CORS_ORIGIN=${PUBLIC_BASE_URL}` | **`network_mode: host`**, no `ports:` (see 9.9), `NODE_IP`, `LIVEKIT_KEYS` | `coturn` service with `profiles: ["turn"]`, `network_mode: host`, `user: "${TURN_UID:-0}:${TURN_GID:-0}"`, mounts rendered `turnserver.conf` and `${TURN_CERT_MOUNT:-./tls}:/etc/coturn/certs:ro`. Healthchecks on all services. |

Bundled `Caddyfile` (mode 2): global `email {$ACME_EMAIL}`; site
`{$DOMAIN:localhost}` with `{$TLS_MODE:}`; `encode gzip zstd`; `handle
/livekit/*` with `uri strip_prefix /livekit` → `livekit:7880`, forwarded
headers, `flush_interval -1`, keepalive transport; `handle /api/*` →
`api:8080`; `handle /health` respond OK; catch-all → frontend; headers
`Content-Security-Policy "frame-ancestors *"`, `-X-Frame-Options`,
nosniff, XSS, `Referrer-Policy strict-origin-when-cross-origin`.

Mode-5 reference snippets (single-domain Caddy, single-domain nginx,
three-domain Caddy, three-domain nginx) must encode the **strip-prefix
rule**: only `/livekit/*` is stripped; `/api/*` and `/ws/*` keep their
prefix. LiveKit routes need `flush_interval -1` / `proxy_buffering off` and
24 h read/write timeouts; API routes need a 50 MB body limit; all sites
remove `X-Frame-Options` and set `frame-ancestors *`.

### 7.5 Mode-5 environment (`deploy/external-proxy/.env.example`)

Documented sections: public URLs (`PUBLIC_BASE_URL`, optional
`PUBLIC_API_URL`, `PUBLIC_LIVEKIT_URL`), `BIND_HOST`, service ports
(`FRONTEND_PORT`, `API_PORT`, `LIVEKIT_WS_PORT`, `LIVEKIT_TCP_PORT`), media
(`LIVEKIT_UDP_PORT_RANGE_START/END`, `LIVEKIT_NODE_IP`), LiveKit credentials
(`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_KEYS`, with the
"change all three together" warning), persistence notes, TURN
(`TURN_ENABLED`, `TURN_DOMAIN`, `TURN_USERNAME`, `TURN_PASSWORD`,
`TURN_TLS_PORT`, `TURN_UDP_PORT`, `TURN_RELAY_RANGE_START/END` default
55000-60000, `TURN_CERT_MOUNT` default `/var/{{product_slug}}-tls`,
`TURN_CERT_FILE`, `TURN_KEY_FILE`, `TURN_UID/GID`).

`livekit.yaml.template` placeholders: `@LIVEKIT_UDP_PORT_RANGE_START@`,
`@…_END@`, `@NAT_1_TO_1_IPS@` (rendered to `nat_1_to_1_ips: [<public>,
<bridge>]` when they differ), `@TURN_SERVERS_BLOCK@` (rendered to
`turn_servers:` with one TLS entry and one UDP entry when TURN is enabled).

`turnserver.conf.template`: listening/tls ports, `listening-ip=0.0.0.0`,
`relay-ip=@BRIDGE_IP@`, `external-ip=@PUBLIC@/@BRIDGE@`, `realm` and
`server-name` = TURN domain, `lt-cred-mech`, `user=<u>:<p>`, min/max relay
ports, cert/pkey paths, `no-cli`, `no-tlsv1`, `no-tlsv1_1`, `fingerprint`,
`no-multicast-peers`, the standard `denied-peer-ip` private-range list,
`allowed-peer-ip=@BRIDGE_IP@`, `total-quota=100`, logging to stdout.

### 7.6 Scripts

- `install.sh` (bash, idempotent): banner; detect OS; offer to install
  Docker/Compose/curl/git (and nginx/certbot for mode 3); clone or reuse the
  repo; menu of 5 modes + "production (coming soon)". Per mode: prompt for
  domain/email/IP, generate random LiveKit key/secret **once** and reuse on
  rerun, write `.env`, render templates, `docker compose up -d --build`, wait
  for healthy, print URLs and next steps. Mode 5 additionally: choose
  single- vs three-domain layout, auto-detect public IPv4 (`ifconfig.me`) and
  confirm `LIVEKIT_NODE_IP`, detect the bridge IP, offer to enable coturn
  (reuse main cert vs dedicated `turn.<host>`), generate `TURN_PASSWORD`,
  stat the cert to set `TURN_UID/GID`, create `tls/` with a README, start with
  `--profile turn`, then print the same summary as `info.sh`.
- `update.sh`: detect running mode (or `--mode N`), `git pull` (warn on dirty
  tree), rebuild (`FORCE_REBUILD=1` → `--no-cache`), restart, preserve `.env`,
  certs, keys; for mode 5 re-render templates, reconstruct a missing
  `LIVEKIT_KEYS`, and pick up `TURN_CERT_MOUNT`.
- `cleanup.sh` (`--quick`, `--force`): remove containers, images, volumes
  (warn: wipes SQLite state), networks, build cache, `.env`, optionally
  `node_modules`.
- `diagnose.sh`: print versions, compose ps, recent logs, listening ports,
  health probes.
- `deploy/external-proxy/info.sh`: port→service map, proxy wiring for both
  layouts, firewall list (443/tcp, 7881/tcp, UDP media range, and TURN ports
  when enabled), Incus `proxy` device commands with the real bridge IP,
  reachability checks (frontend/API/LiveKit `/health`), an `/api`
  strip-prefix probe ("API reached, prefix preserved"), a LiveKit auth probe
  (list rooms with the configured key), an iframe-embedding probe (no
  `X-Frame-Options`, `frame-ancestors` present), and a TURN status section
  (cert files, SAN match, config rendered, container running, 5349
  listening). Use compose service names in printed commands.
- `mount-cert.sh` (runs on the Incus host): discover the host proxy's cert
  directory (proxy-manager Caddy volume, `~/.local/share/caddy`,
  `/etc/letsencrypt/live/<host>`), then `incus config device add <container>
  {{product_slug}}-tls disk source=… path=/var/{{product_slug}}-tls
  readonly=true`; idempotent.

### 7.7 CI (`.github/workflows/external-proxy.yml`)

On push/PR touching `deploy/external-proxy/**`, `frontend/**`, `api/**`:
seed `.env` from the example, `docker compose config --quiet`, build, up,
wait ≤5 min for all services healthy, curl `/health` on 3000 and 8080 and `/`
on 7880 from `127.0.0.1`, fail if any published port is bound to
`127.0.0.1:` only, tear down with `-v`.

---

## 8. Documentation to write

1. **README.md**: one-line install (`curl … | bash`) and manual clone; update
   instructions; requirements; the five modes; features; architecture
   diagrams (demo and with proxy); tech stack; usage; in-call controls table;
   dev commands for each service; env vars; file structure; cleanup; a
   troubleshooting section (camera/mic, can't connect, screen share, state
   persistence and backup with `docker compose cp`, lost admin password →
   `reset-admin.sh`, and the mode-5 top failure modes list); MIT license.
2. **API.md**: everything in Section 4 plus the client library (Section 5),
   join links with Python and Node examples, webhook signature verification
   in Node and Python, WebRTC/simulcast tables, error handling, env vars,
   security considerations, "no rate limiting yet" note.
3. **ARCHITECTURE.md**: components, stacks, key files, endpoint table, and a
   "Current limitations" list (single SFU, no recording, host = first joiner,
   sessionStorage per tab, basic reconnection, no rate limiting, transient room
   metadata).
4. **docs/IFRAME_INTEGRATION.md**: deployment-type URL table (path-based vs
   subdomain), `detectApiUrl` helper, quick start (with/without
   `hideEndCall`), URL params, integration steps, JS class + React + Vue
   examples, security (allow attrs, CSP `frame-src`, CORS), API reference for
   create/list rooms and token, troubleshooting (405 from nginx, camera,
   iframe not loading, room not found), best practices.
5. **docs/install/external-reverse-proxy.md**: topology diagram, prereqs
   (nesting, ≥2 GiB RAM for the Vite build), step-by-step, single- vs
   three-domain table, the strip-prefix rule, why host networking, Incus UDP
   exposure, layer-by-layer verification commands, the full TURN section
   (why cellular fails, enable, cert bind-mount vs dedicated host, firewall
   table, verify on a real cellular phone), known limitations, and the
   symptom → cause → fix troubleshooting table.

---

## 9. Hard-won behaviors (do not regress)

1. **Room singleton, no unmount disconnect.** The LiveKit `Room` lives in a
   module-level singleton; the hook must **not** disconnect in a `useEffect`
   cleanup, or the join→room view transition disconnects the call. Only an
   explicit `disconnect()` or server disconnect tears it down.
2. **Attach remote audio.** Remote tiles need an `<audio>` element with the
   microphone track attached; video alone is silent. Never attach local audio
   (echo).
3. **Unique identity ≠ display name.** Identity is `name_deviceId` (device id
   persisted in localStorage); the human name goes in the token's `name`
   field. Two "John"s can share a room.
4. **Switch to the room view right after signaling connects.** Enabling mic
   and camera can stall forever on symmetric NAT; publish them
   fire-and-forget and let track events flip the UI flags.
5. **Server-chosen quality.** Apply the `quality` from `/api/token` before
   building the room so simulcast layers and codec match; a per-room override
   beats the platform default.
6. **Pass TURN into `Room.connect` via `rtcConfig.iceServers`**; without it
   cellular clients fail even with a working relay.
7. **Sessions survive restarts, and 401 anywhere logs the admin out** with a
   clear message instead of a panel full of failing requests.
8. **Admin panel state in the URL hash** so refresh does not bounce to the
   join screen.
9. **LiveKit uses host networking in the external-proxy stack.** Publishing
   ~10k UDP ports through docker-proxy inside an LXC hangs `compose up` at
   "6/7" and rewrites UDP source ports (breaks ICE). The API reaches it via
   `host.docker.internal` + `host-gateway`.
10. **One source of truth for LiveKit keys.** `LIVEKIT_API_KEY/SECRET` (API)
    and `LIVEKIT_KEYS` (server) must be written together; drift shows up as
    "login works, admin panel Disconnected, `/api/rooms` → Unauthorized".
11. **Strip only `/livekit`.** Stripping `/api` yields `Cannot POST
    /admin/login`.
12. **No buffering, 24 h timeouts on the signaling route**, or calls stick at
    "Connecting…" / drop at 60 s.
13. **Set `LIVEKIT_NODE_IP`** to the host's public IPv4 in NAT'd deployments,
    and render `nat_1_to_1_ips` with both public and bridge IPs so TURN relays
    can reach the SFU without NAT hairpinning. The "could not validate
    external IP" warning at startup is expected when it is set.
14. **coturn must run as the cert file's uid/gid** (Caddy stores certs 0600);
    otherwise it silently skips the TLS listener and cellular still fails.
15. **Split the host UDP range** (media 50000-54900, TURN relay 55000-60000)
    so the firewall forwards one contiguous 50000-60000 block.
16. **Tailwind v4 layers:** never add an unlayered `* { margin:0; padding:0 }`
    reset; it overrides every spacing utility. Rely on preflight.
17. **CSP, not X-Frame-Options.** The frontend nginx, the API, and every
    proxy config remove `X-Frame-Options`; embedding control is
    `frame-ancestors` driven by the admin setting.
18. **Screen-share button hidden when `getDisplayMedia` is missing** (mobile).
19. **Admin WebSocket falls back to polling** after 3 failed attempts so the
    panel still works behind proxies that break WebSockets.
20. **The SQLite volume is named and documented**; `docker compose down -v`
    is the only thing that wipes operator state.

---

## 10. Acceptance checklist

- [ ] `docker compose up -d --build` (demo) → two browsers on different
      networks create/join a room and exchange audio + video + screen share.
- [ ] Join-link parameters behave exactly as in 1.2, including `hideEndCall`
      and URL cleanup.
- [ ] Refreshing a tab inside a call rejoins automatically; opening a new tab
      does not.
- [ ] First admin login sets credentials; restart keeps the session; passkey
      register + sign-in work when `PUBLIC_BASE_URL` is set; `reset-admin.sh
      --reset-all` recovers a lockout without a restart.
- [ ] API key with `X-API-Key` can create/list rooms and mint tokens while
      public access is disabled; the public UI shows the disabled screen.
- [ ] Webhook test and real `room.created` / `participant.joined` /
      `room.deleted` deliveries carry a valid `X-Webhook-Signature`.
- [ ] Settings changes (limits, quality, iframe domains) persist across
      `docker compose down && up` and are enforced by `/api/token` and the CSP
      header.
- [ ] Admin panel shows Live via WebSocket, degrades to Polling when the
      socket is blocked, and survives refresh on any tab via the hash.
- [ ] Swagger UI renders the spec inside the panel; the iframe guide shows the
      correct URLs for the deployment type and downloads as Markdown.
- [ ] Mode 5 CI workflow passes; `info.sh` probes all report ✓ on a real
      external-proxy install; a phone on cellular with wifi off connects
      within seconds when TURN is enabled.
- [ ] A case-sensitive `git grep` for every name on your forbidden list
      (any prior product name, vendor, or client not equal to
      `{{PRODUCT_NAME}}`) returns nothing across code, docs, and configs.

---

## 11. Build order

1. **Scaffold + API core**: repo layout, API with config, SQLite + migrations,
   health/status/room-code/token/end-meeting, admin login/logout/sessions,
   CORS + CSP middleware, startup banner, Dockerfile. Verify with curl.
2. **Admin API**: stats, settings, rooms CRUD, API keys (+rotate), webhooks
   (+test, dispatcher), WebSocket channel, OpenAPI document, reset-admin CLI.
3. **Frontend core**: Vite/Tailwind/theme, client library (detection,
   presets, session, links), stores, `useLiveKit`, JoinForm, VideoRoom and
   tiles, screen-share layout, PiP, ControlBar + modals, toasts, App flow.
4. **Admin panel**: login (password + passkey), data loading + WS/polling,
   the five tabs, hash routing, unauthorized handling. Passkey backend
   (`webauthn.ts`) lands here too.
5. **Deployment modes 1-4**: compose files, Caddyfile, nginx template,
   livekit.yaml, frontend nginx, install/update/cleanup/diagnose scripts.
6. **Mode 5 + TURN**: external-proxy stack, templates, reference proxy
   snippets, info/mount-cert/reset-admin scripts, CI workflow.
7. **Docs**: README, API.md, ARCHITECTURE.md, iframe guide, external-proxy
   guide. Run the acceptance checklist and the brand-name grep.

Commit at the end of each phase with a message that names the phase.
