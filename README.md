# THE EXPERIMENT

A responsive, account-free social experiment for 1–8 human players, with CPUs filling a 4–8 Subject roster. Keep Group Stability alive while earning private Compliance. There is no designated villain: the Experiment gives ordinary players competing instructions.

This repository implements the first playable scope in the [approved implementation plan](docs/implementation-plan.md). Secondary mechanics and submission assets are tracked in that document rather than represented by nonfunctional game controls.

## Play from the release ZIP

Get the [prepared v0.2.0 ZIP](https://github.com/jamesmorris0330-ops/Design-1/blob/main/releases/the-experiment-0.2.0.zip) and click **Download raw file** on GitHub. The prepared ZIP includes compiled client/server files and the local launchers.

Install **Node.js 24**, extract the complete release ZIP, then run **start-local.cmd** on Windows or `bash start-local.sh` on macOS/Linux. The launchers install runtime dependencies on first use and run the included compiled game. See [PC and same-Wi-Fi instructions](docs/pc-quick-start.md). No hosting account is required for local play.

## Development

Requires **Node.js 24**. No hosted database, identity provider, or API key is needed for local development.

```sh
npm ci --cache .npm-cache
npm run dev
```

Vite serves the client on port 5173 and proxies API/WebSocket requests to the server on port 3000. Open separate browser profiles or devices to create and join a room with its code. Multiple tabs in one browser profile share an anonymous identity; the newest controlling tab supersedes the older one.

Room settings support 3–20 total rounds, including one finale, with a 15- or 20-round cap. Before the finale, the host can propose extra ordinary Trials, subject to majority consent. Extensions retain the original Compliance requirement.

Solo hosts can mark ready and start with CPU players. The lobby also lets the host add CPUs up to eight total Subjects. New humans joining during active play take available CPU seats and inherit the Subject's score, dossier, and locked actions. See [CPU and takeover rules](docs/cpu-players.md).

## Checks

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Browser tests use installed Chromium when available, or a Playwright-managed browser. On a new machine without Chromium, install it with `npx playwright install chromium` using the normal verified download process.

## Production

```sh
npm ci --cache .npm-cache
npm run build
npm start
```

The compiled Node service serves the built client and the WebSocket endpoint together. Place it behind HTTPS with WebSocket upgrade support, run **one application replica**, and mount a persistent writable data directory. Set `NODE_ENV=production` for secure session cookies. See [deployment guidance](docs/deployment.md).

Anonymous session identity is stored in an HttpOnly cookie. Retain that browser profile to reclaim a Subject after refreshing or reconnecting. A nickname and room code cannot recover a different session's Subject.

## Architecture

The server owns all scoring, randomized assignments, transitions, timers, decisions, ballots, and disclosures. SQLite snapshots and command receipts commit atomically before acknowledgement. Browsers receive an explicit public projection plus only their own authorized private state; spectators receive public information only.

See [game rules](docs/rules.md), [implementation plan](docs/implementation-plan.md), and [deployment guidance](docs/deployment.md).
