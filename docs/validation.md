# Validation of release 0.4.0

## Automated checks

TypeScript checks and the production client/server build passed. The full Vitest suite passed **157 tests across 11 files**:

- 27 survival core tests: server movement, stale intentions, finite ammunition, hit detection, enemy damage, recovery, horde completion, loot conservation and refill, five shelters, CPU behavior, duties integrated with actual actions, calendar minutes, and offline clock freezing.
- 17 progression tests: paid crafting/upgrades and job timers, recruitment and survivor roles, shelter movement, capacity, calendar goals, claims, and achievable goals after finite content is exhausted.
- 19 governance tests: private ballots, CPU voting restrictions, ties, membership removal, stable seat identity, communal transfers and healing, daily duties, missed-duty penalties, and reelection reward safeguards.
- 6 survival HTTP/WebSocket/storage tests: authoritative real-time movement, observer privacy, stable CPU takeover, reconnect and server restart, durable command receipts and normal negative acknowledgements, and bounded continuous-input storage.
- 10 audio tests: public narration and cues, survivor speaker identity, reconnect history, availability, and private-state exclusion.
- 78 existing domain, CPU, HTTP/socket, and full-match tests preserve compatibility for older saved round-based rooms. Their former UI scenarios are archived in `tests/legacy-e2e`; new rooms use survival, and current browser scenarios are in `tests/e2e`.

Production dependency audit reported **zero known vulnerabilities** for the installed runtime dependency set. `git diff --check` passed. The intentional persistence-failure test emits a safe structured error and proves health becomes unavailable until successful retry.

## Browser and PC package checks

The compiled ZIP was extracted into a writable path containing spaces. `start-local.sh` installed runtime dependencies with the frozen lockfile and started its included client/server. The real health endpoint returned success. Browser checks use the cloud machine’s LAN IPv4 over plain HTTP with independent anonymous browser profiles, system Chromium, phone emulation, and `PLAYWRIGHT_NO_PROXY=1`. This also exercises the secure-random command ID fallback for local HTTP.

All six extracted-package browser scenarios passed across the candidate runs:

1. Real pointer/keyboard combat and scavenging, paid crafting, gear creation, and weapon improvement.
2. Stable CPU takeover, private inventories, and refreshed-player recovery.
3. 375px phone movement, calendar goals, and overflow checks.
4. Actual Web Audio activation, public NPC speech dispatch, animated speaking portraits, mute, and private-state exclusion.
5. Private ballots, a paused refresh with locked votes, Captain appointment/duty, and conserved communal deposits/withdrawals.
6. One human plus three CPUs through the real 90-second preparation period and an 18-enemy horde, using pointer defense and reloads. The horde finished, shared wave progress advanced, and the shelter survived.

The final two scenarios were rerun after fixing navigation labels so a duty counter cannot change the button’s accessible name. No further runtime changes followed. The horde left the shelter at full health, so the browser scenario’s conditional paid-repair branch did not execute; repair costs and completion remain verified by domain tests.

Desktop and phone screenshots were visually inspected. No horizontal overflow or JavaScript errors were found. Review corrections included truthful horde-preparation copy, fractional clock minutes, stable navigation labels despite counters, readable spawn labels, and 44px Duties controls on phones.

Speech lifecycle checks use a mock device speech service because CI Chromium has no installed voices; the Web Audio context and oscillators remain real. These checks prove public text dispatch, speaking animation, mute behavior, and private-data exclusion. Audible voice availability and quality depend on each player’s browser and installed voices.

ZIP packaging checks integrity, includes compiled code and public artwork, normalizes the Windows launcher’s line endings, excludes database files, credentials, Git metadata, and dependencies, and produces an external SHA-256 checksum. The final archive’s compiled client/server and artwork bytes were compared with the tested extracted runtime before upload.

## Validation boundaries

Runtime verification used Linux and Chromium. The Windows launcher received static review; Windows execution, independent physical-device/Wi-Fi access, and public deployment remain unverified. Docker image construction was attempted, but its dependency-install stage did not finish in this cloud environment; the image was not runtime-tested. The Dockerfile includes public artwork, and hosting instructions describe the required Node.js, storage, and WebSocket contract.

A public game URL still requires hosting. The PC ZIP works locally; uploading it to GitHub does not publish an online game server. Noise attraction, riskier expeditions, new infected species, weather, and other recommendations are future work.
