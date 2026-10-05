# MineflayerBuilderBot

A Mineflayer-based Minecraft builder with one leader bot and up to three worker bots. It supports fast area filling, vertical wall building, coordinated worker jobs, storage scanning/refilling, and owner-only private-message controls.

## Features

- Leader + up to 3 worker bots
- `stream` mode for filling rectangular build areas
- `wall` mode for vertical planes
- Automatic chest/shulker discovery and material refills
- Worker rally/TPA coordination
- Pause, resume, stop, status, and block selection commands
- Owner-only command handling
- Optional server login/register dialog handling
- Post-install collision epsilon patch for the current 1.21.x setup

## Requirements

- Node.js 20+ recommended
- A Minecraft server compatible with the configured Mineflayer version
- Bot accounts/usernames allowed by the server
- Permission to use automation on the server

## Install

```bash
npm install
```

Create your private local config:

**Windows PowerShell**

```powershell
Copy-Item config.local.example.js config.local.js
```

**Linux/macOS**

```bash
cp config.local.example.js config.local.js
```

Edit `config.local.js` with your server, account names, optional password, Minecraft version, and owner username.

`config.local.js` is intentionally ignored by Git.

## Configuration with environment variables

Environment variables override `config.local.js`:

- `MC_HOST`
- `MC_PORT`
- `MC_USERNAME`
- `MC_WORKER_USERNAMES` — comma-separated worker names
- `MC_PASSWORD`
- `MC_VERSION`
- `MC_OWNER`

## Run

```bash
npm start
```

On Windows you can also run `start.bat`.

## Owner commands

Send commands to the leader bot by private message:

```text
help
mode stream
mode wall
band 1
band 2
band 3
band 4
side auto
side +
side -
from X Y Z
to X Y Z
block stone
start
start 3
pause
resume
stop
status
tpa
```

`start N` selects how many worker bots to use, from 0 to 3.

## Validate source

```bash
npm run check
```

## Important notes

The project contains some server-specific behavior for private-message formatting, TPA flow, server transfer, and login/register dialogs. You may need to adapt those sections for another network.

The `postinstall` script patches `prismarine-physics` for the current setup. Review `scripts/patch-prismarine-physics.js` when upgrading Mineflayer or prismarine-physics.

Do not commit real passwords, session data, account tokens, or `config.local.js`.

Use this bot only where automation is permitted by the server rules.
