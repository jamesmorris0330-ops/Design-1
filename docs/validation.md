# Validation of release 0.2.0

## Completed checks

- TypeScript checks and production client/server build passed.
- 26 engine tests passed: private projections, compatible directives, scoring, mixed votes, whole-match progress, extensions, timer/pause state, removal, finale, collapse, abort secrecy, and rematch.
- 14 CPU-seat engine tests passed: solo fill, eight-seat cap, readiness, stable identity, inherited scores/history/locked inputs, takeover after pause, legacy memberships, and restrictions on CPU hosting and postgame takeover.
- 12 CPU-policy tests passed: actual allocations, Medical restrictions, public/own-private information only, ballots and extension consent, final statements/choices, delay, pause, removal, takeover cancellation, and durable once-per-phase discussion.
- 5 real WebSocket server tests passed: private-only updates, duplicate receipts, controller fencing, restart recovery, sessions/origins, host transfer, hard-deadline enforcement, and storage-failure recovery.
- 5 CPU HTTP/WebSocket tests passed: solo full game and rematch, simultaneous retained-seat joining, inherited private state and reconnect, maximum roster and human hosting, paused restart/resumption, and exact deadline-before-join ordering with spectator admission after collapse.
- 6 complete socket matches passed: 3 / 5 / 7 / 10 / 15 / 20 total rounds, including exactly one finale. The 20-round match used eight Subjects. Checks included server timer transitions, exact personal results, complete reveal history, and dossier score accounting.
- All 68 engine, policy, and socket tests passed in the full suite.
- All 5 Chromium browser scenarios passed against the extracted, compiled v0.2.0 PC release: one human with three autonomous CPUs through the full finale and rematch; locked CPU takeover, refresh, concurrent joins and spectator privacy; four independent Subjects with mobile controls and reconnect; eight Subjects with majority-approved extensions; synchronized custom lengths and 15/20 caps.
- Desktop landing and phone-sized secret-decision screenshots were visually inspected; no horizontal overflow was found. Mobile allocation controls provide 44px touch targets and navigation to Trial, Dossier, and Chat.
- The frozen-lockfile installation script was executed successfully, followed by a fresh production build.
- Production dependency audit reported zero known vulnerabilities for the installed dependency set.
- The release ZIP was extracted into a folder with spaces, installed with runtime dependencies only, and started using `start-local.sh`. Its built client and server worked over the cloud machine's LAN IPv4 HTTP address.
- The browser run used the cloud machine's LAN IPv4 over plain HTTP, including mobile emulation, exercising the secure-random-byte command ID fallback on an insecure browser origin. It used `PLAYWRIGHT_NO_PROXY=1` to bypass the cloud browser's proxy for local-network access.
- The v0.1.0 package previously passed an independent four-player complete-match/restart smoke. Version 0.2.0 preserves its launchers and adds the CPU transport/browser checks above. ZIP integrity and exclusions are checked during packaging; runtime installation uses the frozen lockfile.

The intentional persistence-failure test emits a safe structured error and verifies that health becomes unavailable until a successful retry. This is a tested failure condition, not an unresolved test failure.

## Boundaries

These checks verify the current cloud instance, built service, and extracted PC package. Windows launcher execution, independent physical-device/Wi-Fi access, public deployment, Docker image construction, and restoration after cloud publication have not been validated. The Windows launcher received static review; runtime verification used Linux and Chromium. The Dockerfile and deployment instructions are provided for a hosting target supporting the documented runtime contract.

The first playable scope is implemented. Secondary mechanics listed in the approved roadmap have not been enabled or represented as completed features.
