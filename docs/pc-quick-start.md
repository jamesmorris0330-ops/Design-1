# Play on your PC and local Wi-Fi

This release includes the built game; your PC runs its server while everyone plays in a browser. You need **Node.js 24**, Internet access for the first dependency installation, and at least one human. Up to eight humans and optional CPU companions can share a world. Local play needs no hosting account, domain, or paid service.

## Start on Windows

1. Install **Node.js 24** from [nodejs.org](https://nodejs.org). Keep the installer's npm option enabled.
2. Extract the complete release ZIP into a writable folder, such as Documents. Do not run the launcher inside the ZIP or from Program Files.
3. Open the extracted `the-experiment-0.4.0` folder and double-click **start-local.cmd**. The first launch installs dependencies; subsequent launches reuse them.
4. Keep that window open. Type `http://localhost:3000` into your browser for PC-only play.
5. Create a room. The host chooses a starting shelter and can use **Add CPU player** for optional companions. Everyone human chooses **Mark ready**, then the host chooses **Start survival**.

A solo host can start without CPUs. A friend joining with the room code can take an available CPU seat, keeping its position, inventory, equipment, progress, and elected duties. See [CPU companions](cpu-players.md).

## Sound and controls

Click **Enable sound** to unlock browser audio. You can mute sound, switch voices off separately, or change the volume. Speech uses voices installed on the browser/device; visible dialogue remains when voices are unavailable. Refreshing requires another click to enable sound. Private inventory and election ballots are not spoken automatically.

On a computer, use **WASD / arrow keys** to move, mouse to aim, hold the left mouse button to shoot, **E** to collect supplies or rescue a nearby survivor, and **R** to reload. On phones, drag the left stick to move and hold/drag the right stick to aim and fire; tap **Collect**, **Rescue**, or **Reload** when needed.

Use the **Inventory**, **Craft**, **Crew**, **Shelter**, **Goals**, and **Duties** panels to manage your survivor and community. Return near the shelter to craft, upgrade, deposit, or withdraw supplies. Jobs show their material costs and completion timers. **Duties** also opens elections and offers treatment for nearby injured survivors.

Keep food, water, ammunition, and medicine available. A full day lasts one real hour of active play by default. The first day starts at 08:00; subsequent full day/night cycles last the selected duration. The world pauses automatically when every human disconnects. Host pause also stops its clock, attacks, needs, jobs, and election timers.

## Join from phones or other computers

1. Connect the PC and other devices to the same Wi-Fi network.
2. On Windows, open Command Prompt, run `ipconfig`, and find the active Wi-Fi adapter's **IPv4 Address**, for example `192.168.1.25`.
3. Everyone, including the host on the PC, should type `http://192.168.1.25:3000` into their browser, replacing the example address with the PC's address. Use this address from the beginning and keep using it to preserve your player identity. Localhost and the LAN address have separate browser identities.
4. If Windows asks about firewall access, allow Node.js on your private home network. Guest Wi-Fi with device isolation may prevent phones from reaching the PC.
5. One person creates a room; the others enter its code and their nicknames. Everyone marks ready before the host starts. Read and type the displayed room code if the copy button is unavailable over local HTTP.

Keep the PC awake and the launcher running. Refreshing a browser reconnects its existing player. Use separate devices or browser profiles for separate players; tabs in one profile share one player, and the newest controlling tab takes over.

## macOS or Linux

Install Node.js 24, extract the ZIP into a writable folder, open a terminal in that folder, and run:

```sh
bash start-local.sh
```

For phone access, find the computer's local IPv4 address in network settings and follow the shared-address steps above.

## Stop, restart, and update

Press **Ctrl+C** in the launcher window to stop the server. Start it again with the same launcher and folder. Rooms are saved in `data/experiment.sqlite`; keep the data folder and players' browser profiles to resume. Time and upgrade jobs do not advance while the server is stopped or all humans are disconnected. Do not run two servers from the same game folder.

To update, stop the older launcher and extract the new ZIP into a new folder. Copy the old `data` folder into the new folder while both servers are stopped if you want to retain rooms. Keep the same browser profile and server address. Existing round-based rooms retain their rules; create a new room for the survival game.

If port 3000 is occupied, close the older launcher or choose another port. In Windows Command Prompt inside the game folder:

```bat
set PORT=3001
start-local.cmd
```

On macOS/Linux:

```sh
PORT=3001 bash start-local.sh
```

Use the selected port in every browser address. If dependency installation was interrupted, delete only `node_modules` and rerun the launcher. Keep `data`.

This local address works while devices can reach your PC. To invite people over the Internet, deploy the server using the [public hosting instructions](deployment.md); publishing a repository or ZIP alone does not host a playable website.
