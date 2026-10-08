# Download THE EXPERIMENT for your PC

1. Open [the prepared v0.4.0 game ZIP](https://github.com/jamesmorris0330-ops/Design-1/blob/main/releases/the-experiment-0.4.0.zip) on GitHub. If the repository is private, sign in with an account that has access.
2. Click **Download raw file** on the file page. This prepared ZIP includes the compiled game and launchers.
3. Install **Node.js 24** from [nodejs.org](https://nodejs.org), then extract the complete ZIP into a writable folder such as Documents.
4. On Windows, double-click **start-local.cmd** in the extracted folder. On macOS/Linux, run `bash start-local.sh` there. The first launch installs runtime dependencies and needs Internet access.
5. Keep the launcher open and open `http://localhost:3000` in your PC's browser. For phones and other computers, follow [the same-Wi-Fi instructions](docs/pc-quick-start.md).

Create a room, choose one of five shelters, **Mark ready**, then **Start survival**. One human can play alone. The host can optionally use **Add CPU player** in the lobby; friends joining later can replace available CPUs. Click **Enable sound** for sound effects and device-supported voices.

Version 0.4.0 is a continuous survival game: move, shoot infected, collect supplies, craft and upgrade guns and gear, rescue and upgrade survivors, defend and improve one shared shelter, complete calendar goals, and elect officers with daily duties. A full game day is one real hour of active play by default. The world pauses when all humans disconnect. The former social-deduction rounds are retained only for older saved games.

The accompanying `.zip.sha256` file contains the archive's SHA-256 checksum. Downloading GitHub's general **Source code ZIP** does not provide the compiled release launchers expect; use the prepared release linked above.

To update, stop the older launcher, extract this ZIP into a new folder, and launch the new version. To preserve saved rooms, copy the old `data` folder into the new folder while both servers are stopped, and keep the same browser profile and address. Start a new room for the survival game; existing round-based rooms keep their old rules.

Your PC hosts this local game without a hosting account or domain. Its local address is reachable by devices on the same network, not a public Internet link.
