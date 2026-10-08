# THE EXPERIMENT — continuous survival plan and state model

The user's survival brief supersedes the original round-based social deduction design. The [earlier implementation plan](implementation-plan.md) is retained as historical documentation. Version 0.4.0 makes the default game a persistent, real-time top-down survival world with room-code multiplayer, solo play, optional CPU teammates, fighting infected, and one shared shelter. Horde encounters have waves; exploration, construction, and progression continue between attacks.

The user selected **one real hour per full game day** and **one shared shelter with individual duties and elected positions**. This document records the resulting implementation scope and model. It does not claim features planned for later development have been built.

## First complete survival loop

Create/join → choose one of five shelters → enter the world → move and aim → scavenge and defeat infected → collect materials, guns, and gear → rescue survivors → craft and upgrade → elect officers and complete duties → defend against horde waves → complete calendar goals → save/reconnect and continue.

Desktop keyboard/mouse and phone movement/aim sticks control real movement and combat. The server owns positions, map bounds, attack timing, ammunition, hit detection, enemy behavior, loot, recipes, costs, upgrades, survivor support, horde spawning, goal rewards, duties, and elections. Browsers send intentions rather than damage or inventory changes. Paid projects show costs and completion timers.

New worlds support one to eight human/CPU player seats without auto-filling to four. Joining humans take available CPU seats without resetting their state; if no CPU is available and fewer than eight players are present, new survivors can join the active world. Rescued NPC survivors are separate from those player seats.

## Calendar and investment

A full day/night cycle lasts 60 minutes of active play by default; lobby alternatives are 120 or 240 minutes. The first day begins at 08:00, so the first calendar boundary occurs after the remaining two-thirds of the selected cycle. Calendar periods use seven days/week and thirty days/month. Daily, weekly, and monthly community goals reward scavenging, defense, rescue, upgrades, and survival. Each is claimable once for the room; rewards enter the claimant's private pack and can be shared through the communal stash.

When no human is connected, simulation time stops: no attacks, needs depletion, shelter damage, job completion, or election timeout occurs. Host pause is separate and explicit. Persisted worlds resume without catching up offline time after reconnection or server restart.

## Shelter and progression

Farmhouse, Bunker, Warehouse, Apartment, and Ranger Station have different durability, defense, and rescued-survivor capacity. The host selects the starting base. Every player scavenges and defends one shared active shelter using a personal inventory. Alternative sites must be discovered. Host migration requires proximity, sufficient recruited-survivor capacity, and no active horde. It relocates facilities and recruited NPCs, retaining levels and proportional health instead of creating a second base or refilling damage.

Loot includes wood, metal, cloth, electronics, ammunition, food, water, medicine, guns, and gear. Owned guns and gear can be upgraded to level five; armor, backpacks, and boots provide defense, capacity, and movement benefits. Facilities include a workbench, storage, barricade, and rain collector, also with upgrades. Guardians fight, Medics heal, Scavengers bring supplies, and Engineers repair; recruited survivors can be upgraded. Costs are validated before a bounded three-job queue begins paid work.

Roaming infected attack players and the shelter. A preparation raid begins after 90 seconds, followed by nightly hordes. Later hordes include stronger brutes. Players defend through aiming and shooting; range, magazines, reserves, reloads, cooldowns, armor, and health matter. Downed players can recover at the shelter after a 20-second active-time delay while keeping inventory. Shelter destruction ends the expedition; the persistent room can return to its lobby for a new world.

## Shared shelter duties and elections

Everyone receives a daily crew assignment worth two contribution points. Caches, completed projects, goal claims, kills, and actual healing advance it. Five offices are elected: Captain claims a completed goal, Defender defeats six infected, Scout collects three caches, Medic restores 40 health, and Engineer completes two projects. Office assignments are additional to the general crew duty; more than one office may be held by one player.

Any active player can open a position election. The server freezes eligibility at opening, accepts one private immutable ballot per seat, and resolves after all ballots or 30 seconds of active time. CPUs submit ballots too. A unique plurality wins; ties or empty tallies preserve the incumbent. CPU takeover retains its seat's eligibility and locked ballot. New seats wait for a later election. Removed members cannot remain voters or officers.

Every completed duty contributes one food, one water, and six ammunition to the public communal stash. Every unfinished duty costs 20 shelter health at the next day boundary. Reelection transfers the position's daily progress rather than creating a new reward opportunity. Near-base deposits and withdrawals share resources without generating contribution credit. Medicine can treat nearby injured players or recruited NPCs; only actual restored health counts, and downed survivors must use shelter recovery.

## State and visibility model

The room retains anonymous memberships, host, public chat, and persistence. It owns one canonical survival world:

| Record | Canonical state | Browser visibility |
| --- | --- | --- |
| World | Identity, active/pause flags, elapsed active time, last simulation timestamp, day duration, dimensions, tick state | Public clock, map, and lifecycle; internal timing/input details omitted |
| Player | Position, aim/input, health, needs, inventory, weapons, gear, magazine, cooldown, recovery, behavior totals | Public position, health, equipped weapon/level, firing; private needs, pack, owned equipment, ammunition, statistics, and recovery timer only to its controller |
| World objects | Containers and secret contents, enemy behavior/cooldowns, rescue markers, shelter discovery sites | Public locations and visible conditions; secret loot contents and enemy internals omitted |
| Shelter | Active site/type, level, health, defense, capacity | Public, shared by the room |
| Progression | Recruited NPCs and behavior timers, facilities, paid jobs, goal progress/claims | Public NPC/facility levels, jobs and timers, goal progress/rewards; NPC internal schedules omitted |
| Community | Officeholders, per-player duties, communal stash, elections and all ballots | Public officers, assignments, stash, candidates, ballot count, deadline; only the viewer's own pending ballot is private |
| Horde | Active wave, number/completions, next encounter and spawn scheduling | Public encounter state; internal spawning details omitted |
| Persistence | Canonical snapshots, private authentication linkage, command IDs/receipts | Server only; each actor receives its own acknowledgement |

Construct explicit public and private projections; never serialize the canonical world into a browser response. Spectators receive no private player record. The host cannot inspect another pack or ballot. CPU seat takeover rebinds an authenticated controller to the existing canonical player, preserving equipment, inventory, progression, and office duties. Serialized room commands and atomic SQLite snapshot/receipt commits prevent competing clients from spending or receiving a reward twice.

## Presentation and delivery

The main screen is an animated top-down survival map with shelter illustrations, survivor portraits, muzzle flashes, impact feedback, day/night lighting, and a minimap. The original frontier artwork frames the landing page. Sound requires an explicit browser gesture; public narrator and survivor speech use available device voices, with visible dialogue as fallback. Private packs and ballots are not spoken automatically.

Verify movement and combat, attacks, ammunition/reloads, loot conservation, paid recipe/upgrade timers, recruitment, shelter choice/discovery/migration, calendar goal refreshes, duties/elections and ballot privacy, communal supplies, save/restart, offline freezing, CPU takeover, own-inventory projection, responsive controls, and synchronized multiplayer. Package the compiled client/server with PC launchers and upload the new release ZIP to the authorized GitHub repository. Actual verification outcomes belong in [validation notes](validation.md).

Possible next additions are noise-driven threat, riskier supply runs with rare loot, screamers and runners, and storms or rescue-signal emergencies. Advanced crafting trees, vehicles, and trading also remain future work. Finish and test the core loop before expanding these systems.
