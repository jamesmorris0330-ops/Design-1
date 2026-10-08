# Play on your PC and local Wi-Fi

You do not need a hosting account, domain, or paid service. This release includes the built game; your PC runs its server while everyone plays in a browser. It needs **Node.js 24**, an Internet connection for the first dependency installation, and at least one human. CPUs fill the remaining seats in a 4–8 Subject group.

## Start on Windows

1. Install **Node.js 24** from [nodejs.org](https://nodejs.org). Keep the installer's npm option enabled.
2. Extract the complete release ZIP into a folder you can write to, such as Documents. Do not run the launcher inside the ZIP or from Program Files.
3. Open the extracted `the-experiment-0.2.0` folder and double-click **start-local.cmd**. The first launch installs dependencies; subsequent launches reuse them.
4. Keep that window open. Type `http://localhost:3000` into your PC's browser for PC-only play.

Create a room, mark ready, and choose **Start with CPU players** to play alone. Use **Add CPU player** in the lobby for a larger roster. CPUs are labeled, follow the normal rules, and make their own decisions. A human joining during active play replaces an available CPU, inheriting its score and dossier; decisions it already locked remain locked.

## Join from phones or other computers

1. Connect the PC and other devices to the same Wi-Fi network.
2. On Windows, open Command Prompt, run `ipconfig`, and find the active Wi-Fi adapter's **IPv4 Address**, for example `192.168.1.25`.
3. Everyone, including the host on the PC, should type `http://192.168.1.25:3000` into their browser, replacing the example address with the PC's address. Use this address from the beginning and keep using it to preserve your Subject identity. Localhost and the LAN address have separate browser identities.
4. If Windows asks about firewall access, allow Node.js on your private home network. Guest Wi-Fi with device isolation may prevent phones from reaching the PC.
5. One player creates a room; the others enter its code and their nicknames. Everyone marks ready, then the host starts. Read and type the displayed room code if the copy button is unavailable over local HTTP.

Keep the PC awake and the launcher running. Refreshing a browser reconnects its existing Subject. Use separate devices or browser profiles for separate players; tabs in the same profile share one Subject, and the newest controlling tab takes over.

## macOS or Linux

Install Node.js 24, extract the ZIP into a writable folder, open a terminal in the extracted game folder, and run:

```sh
bash start-local.sh
```

For phone access, find the computer's local IPv4 address in its Wi-Fi/network settings and follow the same shared-address steps above.

## Stop, restart, and troubleshoot

To update from an older release, stop the old launcher before starting the new version. Extract the new ZIP into a new folder. If you want to retain saved rooms, copy the old `data` folder into the new game folder while both servers are stopped. Keep the same browser profile and server address. Older human rooms remain human; CPU support does not replace existing human Subjects.

Press **Ctrl+C** in the launcher window to stop the server. Start it again with the same launcher and folder. Rooms and anonymous identities are saved in `data/experiment.sqlite`; keep the data folder and the players' browser profiles to resume. Do not run two servers from the same game folder.

If port 3000 is already occupied, close the other service or use a different port. In Windows Command Prompt inside the game folder:

```bat
set PORT=3001
start-local.cmd
```

On macOS/Linux:

```sh
PORT=3001 bash start-local.sh
```

Use the selected port in every browser address. If installation was interrupted, delete only the `node_modules` folder and rerun the launcher. Keep the `data` folder.

This local address works while devices can reach your PC; it is not a public Internet game URL. When you want remote players, use the separate [deployment instructions](deployment.md) for an HTTPS service with persistent storage.
