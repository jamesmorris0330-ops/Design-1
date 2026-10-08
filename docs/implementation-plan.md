# THE EXPERIMENT — implementation plan for approval

Status: approved by the author; implementation underway. The supplied design is the source of truth. Numerical defaults below were approved with this plan; changes to game mechanics must be stated explicitly.

Revision: supports up to 20 total rounds, including the finale, with optional pre-finale extensions, solo play with CPU Subjects, and human replacement of available CPU seats.

## 1. What the first playable version includes

Build a responsive, real-time game for 4–8 total Subjects, with 1–8 humans and CPUs filling remaining seats, entered by room code and nickname without accounts. There is no fixed villain. A Subject wins only if Group Stability remains above zero **and** their own Compliance meets their requirement.

The first complete version includes:

- Create/join, lobby, 3–20 total-round settings including the finale, optional pre-finale extensions, ready state, and default spectator access for arrivals after play starts.
- Public chat for remote discussion; private directives, secret decisions, visible Stability, usually private Compliance, and a private dossier.
- One resource-allocation Trial family with curated crisis/directive combinations, rather than arbitrary generated rules.
- The entire ordinary loop: Public Crisis → Private Directive → Discussion → Secret Decision → Resolution → Reveal → Mixed Vote → Consequences → Dossier Update.
- Exposure, Restriction, and Trust ballots selected by the Trial. Different round counts exercise the same engine; the shortest game need not contain every ballot category.
- The full finale: Final Interrogation → Final Directive → binary Final Choice → Stability Resolution → Personal Results → Full Reveal.
- Persistent post-game rooms, rule/settings changes between games, host transfer, and rematches with fresh game state and retained membership.
- Refresh/reconnection, durable recovery, and host Pause, Resume, Transfer Host, Remove Player, Mute Chat, advance a stuck phase, and End Game. Host authority does not expose other players' secrets or permit score editing.
- A short lobby introduction, contextual first-use help, and a permanent How to Play panel.

Secondary mechanics are retained in the roadmap: official contracts, limited DMs, temporary alliance channels, anonymous-message Trials, Evidence Board and formal accusations, earned abilities, identity suppression, temporary isolation and rare elimination, announced rare deception, additional Trial families, adaptive Light/Standard/Intense presentation, optional practice, behavior-based awards, sound, and animation. They will not be silently replaced with simpler mechanics.

The author requested solo play and CPU replacement after the first release. Host start now fills the roster to four Subjects when fewer humans are present, and lobby CPU additions support up to eight. New humans can take an available CPU seat during active play, inheriting that seat's score, dossier, eligibility, and locked actions. This is a change of controller for an existing Subject; it does not add a fresh mid-game Subject or alter the scoring rules. Without an available CPU, late arrivals retain the spectator admission rules. See [CPU rules and state model](cpu-players.md).

## 2. Technical architecture

Use TypeScript throughout: React + Vite for the browser; Fastify + WebSockets for the authoritative Node.js server; schema-validated protocol messages; SQLite in WAL mode for durable state. Use Node.js 24 already present in the environment. Keep public protocol types separate from server-only game logic and secrets.

One server process owns every room. A serialized queue per room handles player commands, timers, and host controls. Each accepted mutation atomically persists the game snapshot, event history, and command receipt **before** acknowledging or publishing it. The server selects compatible content, assigns directives, resolves choices, computes scores, enforces abilities/contracts when added, and decides disclosures and victory.

SQLite deployment requires a persistent disk and exactly one application replica. An ephemeral or multi-replica host requires managed PostgreSQL, such as Supabase, accessed by the server. We will not publish canonical game rows through a client-readable database subscription. The first version is designed for reliable 4–8-player rooms, with no claim of distributed scaling.

Use one origin for HTTP and WebSockets. During development, Vite proxies API/socket traffic to the server. Production serves the built client and socket endpoint from the Node service. Do not require a third-party identity account or backend credential to run the local game.

## 3. State and data model

| Record | Core fields | Visibility |
| --- | --- | --- |
| AnonymousSession | Session ID, token digest, expiry, revocation | Server only; identity credential is an HttpOnly cookie |
| Room | ID/code, host membership, lobby settings, lifecycle, current game ID, expiry | Authorized public projection; never authentication data |
| Membership | Room/session linkage, member ID, nickname, join order, Subject/spectator role, administrative status | Public nickname/role; session linkage remains private |
| Game | Game ID, rules/schema versions, frozen initial settings, initial/planned round counts, round cap, round index, phase, Stability, outcome, selected content, canonical revision | Canonical record is server only; authorized round-plan fields are public |
| Phase | Unique phase ID, type, eligible Subject IDs, opening time, hard/soft deadline, paused time remaining, completion status | Only permitted phase information becomes public |
| ExtensionProposal | Proposal/checkpoint IDs, current and proposed round totals, added ordinary Trials, frozen voter roster, secret ballots, deadline, committed outcome | Public proposal and final consent tally; individual pending ballots remain private |
| SubjectState | Game/member IDs, Subject number, Compliance/requirement, directives, secret choices, restrictions, future powers and contracts | Server and that Subject; explicit reveals publish specific facts |
| Decision / Ballot | Game/phase/actor, validated allocation or choice/target, lock status, receipt | Private until that Trial's disclosure rule permits publication |
| Knowledge / DossierEntry | Owner, source event, learned fact, directive/choice/effect/score history, visibility rule | Owner only; derived from what the Subject is entitled to know |
| GameEvent | Ordered server event, rule effects, audit facts, timestamps, disclosure policy | Canonical event history is server only |
| PublishedEvent | Public ID, approved disclosure, phase/round, provenance | Public record; later feeds the Evidence Board |
| ChatMessage | Room/game/channel, sender, content, recipients, time | Public chat initially; later private-channel messages only to authorized recipients |
| CommandReceipt | Actor + command ID, payload digest, acceptance/rejection, committed result | Server; actor receives their own receipt |
| FinalResult | Survival, Compliance/requirement, qualified status, directive count, trust rank, recorded behaviors | Own result first; prescribed Full Reveal follows |
| ConnectionRuntime | Socket identity, controlling-connection generation, heartbeat, reconnect state | Runtime only; connection loss does not erase a Subject |

Room lifecycle is Lobby → Running → Post-game → Lobby, with a separate Closed state. Game outcomes distinguish survived, failed, and aborted. Rematches create a new Game ID, reset scores/directives/dossiers/round allowances, and retain the room and memberships. Prior game results remain separately addressable. An extension retains the current Game ID, scores, dossiers, and history; it changes only the explicitly extendable round plan through an authorized transition.

The canonical game is never sent to a browser. Construct three explicit views: public room/game state, one authorized Subject's private state, and a spectator view containing only public information. A host gets the same private view as their own Subject. Final Reveal is a deliberate projection of permitted game facts, never a dump of database records, session credentials, or future private-chat content.

## 4. Synchronization, privacy, and reconnection

- The anonymous session is established by a same-origin HttpOnly, SameSite cookie, Secure in production. Store only its digest. A room code and nickname allow joining; neither can reclaim another Subject.
- Every command carries a command ID, Game ID, Phase ID, type, and validated payload. The server derives the actor from authentication and membership; it ignores/rejects client-supplied authority, scores, identities, or outcomes.
- Freeze phase participants and ballot eligibility at phase opening. Serialize simultaneous commands without rejecting valid actions merely because another Subject acted first. Phase IDs fence late commands from completed phases and prior games.
- Duplicate command IDs return the original receipt; the same ID with a different payload is rejected. Commit before acknowledgement. A lost acknowledgement followed by retry cannot score twice.
- Keep canonical revision numbers private. Publish public revisions only for public changes, and private revisions only to the affected Subject. Do not broadcast hidden-only actions or per-Subject submission badges unless an approved Trial explicitly reveals them.
- Use heartbeat detection and automatic reconnect with bounded backoff and jitter. Reconnection authenticates the existing membership, sends fresh public/private snapshots, and reconciles pending command IDs. Reconnecting or refreshing does not reroll directives, erase scores, or duplicate choices.
- Fence an older controlling socket when a newer connection takes control of the same Subject. Show a clear message in the old tab rather than allowing competing controllers.
- Deadlines use server time. Persist deadlines and pause state; after process restart, restore rooms and run due transitions exactly once through the same authoritative queue. Browser countdowns are displays, not rule authority.
- Validate WebSocket origins, membership, phase/action permissions, nicknames/chat payloads, and join-rate limits. Never log cookies or unrevealed directives/choices in client-facing diagnostics.

## 5. Proposed first-version rules requiring approval

The specification approves the structure and mechanics, but does not give exact scoring values, ties, or timer rules. The following are proposals, not previously approved facts.

| Rule | Proposed initial setting |
| --- | --- |
| Round count | Any integer from 3 through 20 total rounds, **including exactly one** final Trial; lobby presets 3 / 5 / 7 / 10 / 15 / 20 |
| Round cap | Lobby chooses 15 or 20, default 20; starting length and extensions must both fit this cap |
| Extra rounds | Optional pre-finale extension; host proposes +1 / +2 / +3 / +5 ordinary Trials when the addition fits the cap; a strict majority of eligible Subjects must consent |
| Group Stability | Starts at 60; maximum 100; zero or below immediately means group failure |
| Compliance requirement | Ceiling of 1.5 × initial selected round count: 5 / 8 / 11 / 15 / 23 / 30 for the presets; fixed for the entire game, including extensions, and privately shown to each Subject |
| Resource Crisis | Each eligible Subject secretly allocates exactly 3 units across Medical, Security, and Reserve |
| Crisis thresholds | Medical and Security each require at least N units, where N is frozen when the Trial opens |
| Stability effect | Each met threshold gives +10; each missed threshold gives −15; two successes give +20, two failures give −30 |
| Directives | Curated compatible predicates over allocations/outcomes; completing a directive gives +2 or +3 Compliance, disclosed on that Subject's card |
| Reserve | No intrinsic Compliance reward; temptation comes from compatible private directives |
| Exposure vote | Unique highest-voted Subject's just-completed directive becomes public |
| Restriction vote | Unique highest-voted Subject must allocate at least 1 Medical unit in the next ordinary Trial; choose a compatible next directive |
| Trust vote | Unique highest-voted Subject earns +1 Compliance; all trust votes contribute to final trust rank |
| Ballots | One target per voter, no self-targeting; ballots hidden until consequences; tied leaders cause no mechanical effect; abstentions allowed |
| Finale choice | Group Stability change is (40 × protectors − 120 × self-protectors) / starting Subject count; apply all choices together, not sequentially |
| Final directives | Compatible loyalty/self-interest directives give +3 Compliance when fulfilled |
| Victory | Group survives AND the Subject reaches their requirement; reaching the requirement alone cannot win |

The finale formula scales by player count: all choosing Protect Yourself fails even from maximum Stability, while high Stability permits more selfish choices to survive. Store Stability as integer ticks with a game-fixed denominator, so floating-point rounding cannot decide survival. These numbers are starting balance proposals, not a claim of playtested balance.

Ordinary Reveal publishes aggregate Medical/Security/Reserve totals and the Stability calculation. Individual allocations, directive completion, and Compliance remain private until a specific authorized disclosure or Full Reveal. Explain ballot disclosure before anyone votes. Disconnected Subjects remain eligible voters/targets; removed Subjects remain in the historical tally for an already-open ballot. A removed winner is recorded but receives no future reward/restriction, and votes are never redirected.

Use Exposure then Trust for the three-round game; Exposure, Restriction, Exposure, Trust for five; Exposure, Restriction, Trust, Restriction, Exposure, Trust for seven. For other lengths, select a curated mix of these three ballot types, ensure Exposure and Trust are represented, and make the last ordinary Trial a Trust vote. A Restriction only appears when another ordinary Trial remains. Extra Trials follow the same eligibility constraints, and already-played ballots are never retroactively changed. Every game includes Trust data for final ranking; tied trust totals receive tied ranks.

### Optional additional rounds before the finale

Enable extensions in the lobby, default on. After the final scheduled ordinary Dossier Update, and before Final Interrogation or any final private directive, offer a continuation checkpoint whenever room remains below the chosen cap. The host can propose +1, +2, +3, or +5 ordinary Trials; only additions that fit are offered. Added Trials move the single finale later. This allows a short session to continue, gives low-scoring Subjects more chances to earn Compliance, and can provide more evidence or votes when standings are tied.

The offer is identical at every eligible checkpoint. The server does not announce that somebody has low or tied private Compliance, expose a private leaderboard, or give the host extra score access. Subjects can use their own dossier and public Trust standings to decide. Equal Compliance is not an unresolved victory: multiple Subjects may qualify, and tied Trust rankings remain valid. More rounds provide additional play and possible score separation without replacing the group-survival-plus-personal-qualification win condition with a single-winner rule.

Give the host 20 seconds to propose an extension or continue; no proposal continues to the finale. A proposal opens a 30-second secret yes/no ballot among a frozen roster of remaining Subjects. Strict majority means floor(eligible Subjects / 2) + 1 yes votes; a missing ballot counts as no. Publish the consent tally after resolution, not pending individual ballots. One proposal is allowed per checkpoint; rejection proceeds to the finale. Acceptance commits the additional Trials exactly once. Another continuation checkpoint can appear after those Trials, still bounded by the same cap.

Keep Stability, Compliance, private dossiers, restrictions, and history. Keep each Subject's original Compliance requirement fixed: adding more opportunities does not raise the qualification target. Existing allowances and time-limited effects advance under ordinary per-round rules; future contracts obey their original expiry rather than being silently prolonged. Store immutable initialRoundCount, adjustable plannedTotalRounds, the frozen maximum round count, and the extension audit history. Approved extensions are the explicit exception to otherwise frozen match settings.

No extension can revive a group at Stability zero or below, interrupt a finale that has started, reopen completed results, or reuse secrets after Full Reveal. Those cases use a rematch. Host transfer, pause/resume, removal, reconnect, and timer expiry use the same authoritative queue and receipt rules during extension voting. Removal does not lower an already-frozen consent denominator.

The lobby will show an estimated session duration. With the current proposed phase timings, a 20-round match can take roughly 45–60 minutes before extra deliberation or pauses. Longer sessions need content-variety and scoring-balance validation; the point tables remain proposals until playtested.

Directive bundles must offer meaningful competing incentives: for example, reserving at least two units, allocating nothing to Medical, or supplying at least two Medical units. Do not reward a harmless Reserve allocation of one unit as the only conflict. Validate directives against restrictions and available actions, verify an individually plausible route to the Compliance requirement, and ensure the crisis has a feasible group-survival strategy. This does not guarantee that everybody's competing goals can be satisfied together.

All effects for a completed decision/vote phase resolve atomically. Check failure after the complete phase result, rather than depending on command arrival order. Early group failure skips unfinished gameplay and opens results and Full Reveal; every Subject fails the group-survival requirement. Explicit host termination is an abort: no winners or awards, retain already-public history and each Subject's own dossier, and do not disclose still-hidden directives or choices.

A resource Trial missing its deadline records a no-response with zero resource contribution and no reward from that unsubmitted directive. It does not invent a secret action. Ordinary missing ballots abstain. A player does not lose their identity merely because their socket disconnects.

The finale retains the approved two choices. Its choice deadline is a warning; resolution waits until every eligible Subject locks in. Reconnect, pause, or an explicit audited host removal/end action handles a stuck finale. The server will not invent a third ending choice or automatically choose for a Subject.

Proposed timings: crisis introduction 8 seconds; private directive 15; discussion 45; ordinary decision 30; reveal 12; mixed vote 30; consequences 8; dossier update 15. Resolution itself is an atomic server transition. Final statements allow 20 seconds per Subject, final directive 15, final-choice warning 30, and personal results 15 before the persistent Full Reveal. All choices/ballots locked permits early advancement where appropriate.

Pause freezes game actions and stores remaining time; public chat remains available unless muted. Resume restores remaining time. Host advance uses the same published timeout/transition rules and cannot set choices, directives, or scores. Removal preserves committed history and locked inputs; missing decisions contribute nothing and missing ballots abstain. An unsubmitted removed Subject is explicitly excused from the finale's remaining eligibility, never assigned an invented choice. Thresholds and ballot rosters do not silently recalculate mid-phase. Fewer than four remaining Subjects pauses the game and requires restart or End Game. A disconnected host has a proposed 60-second grace period before host authority transfers to the oldest connected Subject.

## 6. Implementation sequence

1. **Rules and protocol foundation.** Encode the approved state machine, content definitions, scoring tables, visibility policies, and command schemas. Add focused engine tests for boundaries and illegal transitions. Set up pinned development commands without external credentials.
2. **Authoritative multiplayer rooms.** Create/join, anonymous identity, Subject/spectator authorization, lobby readiness, public chat, durable room state, snapshots/receipts, reconnect, host controls, and restored deadlines. Exercise four independent clients before building more game screens.
3. **First complete playable loop.** Implement the resource Trial, compatible private directives, Stability/Compliance, all ordinary phases, mixed ballots, and dossiers. Finish the six-stage finale, correct dual-condition winners, deliberate Full Reveal, persistent results, and rematch. Begin with four Subjects and three rounds, then add and exercise the extension checkpoint and all supported counts and lengths through 20 total rounds.
4. **Responsive presentation and onboarding.** Implement landing/create/join/lobby, clearly separate public Trial and private dossier surfaces, contextual help, accessible controls, connection status, touch layouts, and desktop layouts. Avoid accidental private-data exposure in shared screens and notifications.
5. **Reliability gate.** Run the acceptance checks below; diagnose and fix failures before adding secondary mechanics. Package a production build and document the persistent-storage/WebSocket deployment requirements.
6. **Secondary gameplay in tested increments.** Add contracts and limited/private alliance channels; investigation and recorded accusations; abilities and identity suppression; anonymous communication and announced deception; further crises and elimination rules. Each feature needs explicit rule tables and privacy tests before being enabled.
7. **Demo polish and submission.** Add Light/Standard/Intense presentation, optional practice, measured awards/statistics, motion/sound, and prepare the title, cover, description, and public URL. Award claims must have measurable recorded evidence; do not infer successful lies or causal influence from arbitrary chat text. Public deployment needs a supported hosting target and its normal deployment authorization.

Plan approval has been received. This sequence follows the requested MVP ordering; secondary mechanics remain part of the intended game.

## 7. Acceptance checks

- Complete real multi-browser matches with 4 and 8 independent sessions, including simultaneous secret choices, every finale stage, exact results, and rematch in the same room. Exercise the 3 / 5 / 7 / 10 / 15 / 20-round presets, custom lengths, both caps, and all three initial vote modes. Use test-controlled server time for long automated games rather than weakening production timing rules.
- Test accepted/rejected extensions, absent ballots, repeated checkpoints, simultaneous/duplicate proposals, reconnect/restart during consent, preservation of original Compliance targets and scores, valid Restriction scheduling, and a finale that moves exactly once per accepted proposal. Reject extensions at or beyond the cap, after collapse, or after the finale starts. Confirm checkpoint offers and payloads do not reveal private score standings.
- Inspect HTTP/socket payloads and rendered browser state: other Subjects' Compliance, directives, unrevealed choices, ballots, and dossiers must be absent; spectators and hosts receive no extra secrets. Explicit exposure and Full Reveal reveal only authorized facts.
- Disconnect/refresh during directives, decision lock, voting, and finale; restore the same Subject and dossier. Retry after lost acknowledgements, replay duplicates, reuse a command ID with a different payload, and send stale-phase/prior-game commands.
- Restart the server using the same database during a deadline and during pause. Verify state, timers, scores, and events recover without repeated resolution.
- Test host transfer, stale-host permissions, removal, mute, pause/resume, forced advance, abort, late spectator admission, and stale-controller fencing.
- Test exact scoring boundaries: Stability zero fails, threshold Compliance qualifies only if the group survives, simultaneous final choices resolve once, and hidden/private scores agree with authorized final results.
- Verify attainable directive totals, curated content variety, and no score/phase overflow through 20 rounds. Test tied Compliance and Trust standings without inventing a single winner, and ensure final results retain the original requirements after extensions.
- Complete a turn on phone-sized portrait/touch layouts and a desktop layout. Verify private controls, scrolling, timer displays, help, and reconnect feedback remain usable.
- Run engine/protocol tests, TypeScript checks, production build, and browser end-to-end tests. Local verification does not establish a published URL or successful independent-device public demo; verify those separately once deployed.

After implementation, save tested installation/start instructions in the cloud environment configuration, use the existing isolated checkout, and document readiness checks. No Git worktree is needed. Configuration saving, runtime verification, and public deployment are distinct milestones.
