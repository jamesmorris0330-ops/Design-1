# THE EXPERIMENT

A responsive, real-time survival game for **1–8 players**, joined by room code and nickname without accounts. Explore a hostile world, collect supplies, fight infected, rescue survivors, and build one shared shelter. Play alone or add optional CPU companions; friends can take their seats when they join.

Version **0.4.0** replaces the earlier round-based social experiment with continuous survival, as requested. Horde attacks have waves; scavenging, building, duties, and progression continue between them. The [survival plan and state model](docs/survival-plan.md) describe the current game. The [original implementation plan](docs/implementation-plan.md) remains as a historical record of the superseded round-based design.

## Download and play

Open the [prepared v0.4.0 ZIP](https://github.com/jamesmorris0330-ops/Design-1/blob/main/releases/the-experiment-0.4.0.zip) on GitHub and click **Download raw file**. The release includes the compiled client and server, source, documentation, and local launchers.

Install **Node.js 24**, extract the complete ZIP into a writable folder, then run **start-local.cmd** on Windows or `bash start-local.sh` on macOS/Linux. Keep the launcher open while playing. The first launch installs runtime dependencies and needs Internet access. See [PC and same-Wi-Fi instructions](docs/pc-quick-start.md). Your PC can host local play without a hosting account or domain.

Stop an older launcher before starting this release. Extract it into a new folder. Start a new room to use the survival game; saved older round-based rooms retain their previous rules until finished.

## The survival loop

- Choose a **Farmhouse, Bunker, Warehouse, Apartment, or Ranger Station**. Each has different durability, defense, and recruited-survivor capacity. Discover other sites and move the shared base later.
- Move and aim in an animated top-down world. Fire a pistol, rifle, or shotgun; ammunition, reloads, enemy attacks, armor, and recovery matter.
- Collect materials, food, water, medicine, weapons, and gear. Craft and upgrade equipment, recruited survivors, the shelter, and its workbench, storage, barricade, and rain collector.
- Rescue Guardians, Medics, Scavengers, and Engineers whose different abilities support the base. Their illustrated portraits accompany public dialogue.
- Complete daily, weekly, and monthly community goals. A full game day lasts **one real hour of active play** by default. The world pauses when every human disconnects.
- Elect a Captain, Defender, Scout, Medic, and Engineer through private ballots. Everyone has a daily crew duty; elected officers also have position duties. Share supplies through the communal stash and treat injured survivors.

Desktop controls: **WASD / arrows** to move, mouse to aim, hold click to fire, **E** to collect or rescue, and **R** to reload. Phones use separate movement and aim/fire sticks with Collect and Reload buttons. See [game rules](docs/rules.md) and [CPU companions](docs/cpu-players.md).

Click **Enable sound** to unlock ambient sound, combat effects, public narration, and survivor voices. Speech uses voices available on the device; dialogue remains visible if none are available. Voice and volume controls are separate. Private inventories and ballots are never automatically spoken.

## Development

Requires **Node.js 24**. Local development needs no hosted database, identity provider, or API key.

```sh
npm ci --cache .npm-cache
npm run dev
```

Vite serves the client on port 5173 and proxies API/WebSocket requests to the server on port 3000. Use separate browser profiles or devices for separate players. Tabs in one profile share an anonymous identity; the newest controlling tab supersedes the older one.

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Browser tests use installed Chromium when available, or a Playwright-managed browser. On a new machine without Chromium, install it with `npx playwright install chromium`.

## Production and persistence

```sh
npm ci --cache .npm-cache
npm run build
npm start
```

The compiled Node service serves the client and WebSocket endpoint together. Public hosting needs HTTPS with WebSocket upgrades, **one application replica**, and persistent writable storage. Set `NODE_ENV=production` for secure cookies. See [deployment guidance](docs/deployment.md).

The server owns movement, combat, enemy behavior, loot, costs, timers, progression, elections, and rewards. SQLite snapshots and command receipts commit atomically before acknowledgement. Browsers receive a public world view and only their own authorized private inventory, needs, equipment, statistics, and ballots. Spectators receive public information only.

Retain your browser profile and server address to reclaim your player after refresh or reconnect. Keep `data/experiment.sqlite` and its data folder when preserving rooms. A nickname and room code cannot recover another browser session's player.

Further ideas include noise attracting infected, riskier supply runs, screamers, and weather-driven emergencies. These are recommendations for later development, not features claimed by this release.
