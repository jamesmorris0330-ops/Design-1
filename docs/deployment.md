# Deployment

For your own PC and phones on the same Wi-Fi, use the [PC quick start](pc-quick-start.md) and the release's local launchers. They run the compiled service over local HTTP. The instructions below apply when creating a public Internet URL.

## Runtime contract

- Node.js 24, one service process/replica.
- HTTPS public origin and reverse proxy supporting WebSocket upgrade.
- Persistent writable SQLite directory. WAL mode protects atomicity; it does not make ephemeral disks persistent.
- Browser session cookies and WebSockets share the application's origin.

Use a container host with a persistent volume, or a VM/service with durable storage. If the target requires ephemeral storage or multiple replicas, migrate the server persistence to managed PostgreSQL before deploying there. Canonical game rows must remain server-only.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP/WebSocket listen port; default 3000 |
| `HOST` | Bind interface; use `0.0.0.0` in a container |
| `DATABASE_PATH` | SQLite file; use a path inside the mounted data volume |
| `NODE_ENV` | Set `production` behind HTTPS so anonymous cookies are Secure |
| `PUBLIC_ORIGIN` | Exact public HTTPS origin used to validate browser/socket requests behind a reverse proxy |
| `TRUST_PROXY` | Enable only when requests arrive through a trusted reverse proxy; a fixed PUBLIC_ORIGIN is preferred |

No credentials belong in this repository. Room codes are discovery identifiers, not authentication. Back up the database together with its WAL files using SQLite's supported backup procedure or stop the service before copying. Keep only one room-authoritative process; a rolling deployment must not overlap two writers serving the same rooms.

## Container

The included Dockerfile builds the client and server, then runs Node as a non-root user. Mount durable storage at `/app/data`, set `DATABASE_PATH=/app/data/experiment.sqlite`, and terminate HTTPS at the public reverse proxy. Expose port 3000 internally. Verify health and complete a multi-device room before announcing a public URL.

## Release checks

Run type checking, engine/server tests, browser tests, and the production build. Confirm anonymous joining, private inventories and ballots, movement and combat, a complete horde encounter, upgrades, reconnect, and a fresh expedition on the actual public origin. Restart the service during an active room and a paused room; verify identity, inventories, shelter state, upgrade jobs, and active-time clock recovery with the same database.

Local validation and saved cloud setup are separate from publishing the game. A public URL requires a selected hosting target and deployment access.
