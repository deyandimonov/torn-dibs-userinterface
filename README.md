# Torn RW DIBS

Shared target reservation system for Torn ranked wars.

The userscript adds DIBS badges directly to the war page so faction members can
reserve offline targets and avoid multiple people attacking the same enemy.

## Features

- Visual DIBS markers on enemy targets
- Automatic claim / release workflow
- Real-time synchronization through a backend API
- Online targets are automatically excluded
- Works alongside FF Scouter, Torn Tools and Torn War Stuff Enhanced
- No layout modifications of the Torn war page

## Installation

1. Install Violentmonkey or Tampermonkey
2. Install `torn-dibs.user.js`
3. Open the Ranked War page
4. Click the DIBS configuration button
5. Fill:
   - API Base
   - Shared Token
   - Torn API Key

## Backend

This repository contains only the userscript.

A compatible backend is required and must provide:

- `GET /health`
- `POST /api/status`
- `GET /api/dibs/{war}`
- `POST /api/dibs`
- `DELETE /api/dibs/{war}/{target}`

## License

PolyForm Noncommercial 1.0.0