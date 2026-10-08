# Download THE EXPERIMENT for your PC

1. Open [the prepared game ZIP](https://github.com/jamesmorris0330-ops/Design-1/blob/main/releases/the-experiment-0.2.0.zip) on GitHub. If this repository is private, sign in with an account that has access.
2. Click **Download raw file** on the file page. Download this prepared ZIP to get the compiled game and launchers.
3. Install **Node.js 24** from [nodejs.org](https://nodejs.org), then extract the complete ZIP into a writable folder such as Documents.
4. On Windows, open the extracted game folder and double-click **start-local.cmd**. On macOS/Linux, run `bash start-local.sh` in that folder. The first launch installs runtime dependencies and needs Internet access.

The game runs on your PC, port 3000. Keep its launcher open while playing. The ZIP includes `docs/pc-quick-start.md` with steps for joining from phones on the same Wi-Fi. No hosting account or domain is needed for local play.

This release supports 1–8 human players with CPUs filling a 4–8 Subject roster. A solo host marks ready and chooses **Start with CPU players**. Use **Add CPU player** for a larger roster. New humans joining during active play take available CPU seats, retaining their score, dossier, and locked actions. Room-code joining, private directives, voting, reconnection, extensions up to the selected 15/20-round cap, the multi-stage finale, full reveal, and rematch remain available. Later mechanics are documented in the included implementation plan.

The accompanying `.zip.sha256` file contains the archive's SHA-256 checksum.

To update an older copy, stop its launcher, extract the new ZIP into a new folder, and launch the new version. To preserve existing rooms, copy the old `data` folder into the new game folder while both servers are stopped. Keep using the same browser profile and address.
