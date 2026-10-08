# Solo play and CPU companions

One human can start a survival world without companions. In the lobby, the host can use **Add CPU player** to add optional teammates, up to eight total humans and CPUs. Every human must **Mark ready** before the host chooses **Start survival**. CPUs are ready automatically and visibly labeled CPU.

CPU teammates move through the same world, collect supplies, rescue available survivors, fight infected, reload, and return to defend a threatened shelter. They use their own finite inventory and ammunition; their shots and loot follow the authoritative server rules. They participate in shelter elections. They do not complete every elected duty or manage the crafting queue for you. No external AI service or account is needed.

These CPU player seats differ from rescued NPC survivors. NPC Guardians, Medics, Scavengers, and Engineers support the base and can be upgraded; they do not occupy one of the eight player seats and cannot be taken over by joining humans.

## Joining a CPU seat

A new human joining with a room code takes an available CPU seat in the lobby or during active survival. The server changes its controller while retaining the same player ID, position, inventory, weapons, gear, needs, progress, jobs, and community assignments. Already submitted election ballots remain locked. The CPU immediately stops acting for that seat, and the public record announces the takeover.

When no CPU seat is available, an active survival world admits a new player if fewer than eight player seats are occupied. The new survivor receives a starter inventory and spawns near the shared base. At eight players, newcomers observe as spectators when spectator admission is enabled. Completed expeditions do not offer active CPU takeovers; the host can return everyone to the persistent lobby to prepare a new world.

Refresh or reconnect using the same browser profile and server address to reclaim your existing human player. A returning human never takes over another human or consumes a second CPU seat. Separate devices or browser profiles create separate players; tabs in the same profile share one identity and the newest controlling tab supersedes the older one. A room code and nickname cannot reclaim another browser's player.

The host can remove CPU seats using normal player controls. CPUs cannot become host or spectators. Only the host adds CPUs, and additions happen in the lobby.

## Persistence and private state

All CPU activity happens on the server and is saved with the room. CPU inventories and active ballots stay private until that seat is inherited by its authenticated human controller. Browsers receive public player positions, health, equipped weapon, and community activity, not other players' packs or ballots.

The survival clock, CPU behavior, attacks, and paid jobs pause when all humans disconnect; they also stop during host pause. Reconnecting resumes the saved world. The application serializes joins and commands per room and commits snapshots and command receipts atomically before acknowledging them, so simultaneous joins cannot take the same CPU seat.

Older saved round-based games retain their own CPU directives and scoring until they finish. This release's normal create-room flow starts continuous survival; it does not turn a running older match into a survival world.
