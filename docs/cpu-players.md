# Solo play and CPU Subjects

One human can start THE EXPERIMENT. Mark ready in the lobby, then choose **Start with CPU players**. The server fills empty seats until there are four Subjects. The host can also use **Add CPU player** before starting to build a larger group, up to eight total human and CPU Subjects.

Every human Subject must mark ready. CPU Subjects are ready automatically and are visibly labeled CPU. The group-survival and individual-Compliance conditions, scoring, directives, votes, restrictions, extensions, and finale remain the same.

CPUs discuss, allocate resources, vote, deliver final statements, and make final choices. Each CPU uses its own directive and Compliance together with public Stability, messages, and disclosed evidence. It cannot read other Subjects' private information. When Stability is low, it prioritizes survival; otherwise it can pursue its personal directives. CPU actions run on the server, pause with the game, and recover after a restart. No external AI service or account is required.

## Joining a CPU seat

A new person joining by room code takes an available CPU seat in the lobby or during an active game. The human inherits that seat's Subject ID and number, Compliance and original requirement, private directive, dossier, restrictions, and history. Group size, scoring denominators, and phase eligibility remain unchanged. The CPU stops acting for that seat immediately.

An allocation, ballot, extension consent, final statement, or final choice already locked by the CPU stays locked. The new player can review it and take control of future available actions. The public record announces the takeover, and the inherited dossier explains it. Previous CPU messages retain their original sender name.

Refresh or reconnect with the same browser profile to reclaim your existing human Subject. A returning human never replaces another human or takes a second CPU seat. Concurrent joins reserve different seats through the server's room queue. Players cannot become the controller of another human's Subject by knowing its nickname or room code.

When no CPU seat is available during play, newcomers become spectators if the host permits spectators. Completed games do not offer takeovers of their CPU results. Between games, use a rematch and lobby roles to prepare the next roster. CPU Subjects cannot become host or spectators; the host can remove them with the normal removal controls.

## Server state

Memberships store a `controller` value (`human` or `cpu`) and a private session linkage. Older saved memberships without a controller remain human. CPU session identifiers are synthetic server records, never authentication credentials. Public member views expose the controller label; private CPU records stay behind the existing projection boundary.

CPU schedules derive from persisted phase opening times and stable Subject/phase IDs. A private discussion-phase marker prevents repeated messages after recovery. CPU mutations, phase transitions, and joins use the same serialized room queue and atomic SQLite commit path as human actions. A takeover rebinds only the available CPU's membership to the new authenticated session and retains its canonical Subject state.
