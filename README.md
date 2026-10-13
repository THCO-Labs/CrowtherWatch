# CrowtherWatch

The Pebbles freelancer time tracker — a standalone desktop app (Windows, macOS, Linux) that records a
freelancer's working sessions and takes a **disclosed, consented** screenshot every 30 minutes as
proof of work. Part of the CrowtherWatch feature (see the backend's `docs/adr/0023`).

## What it does

1. **Sign in** with email + password + the 2FA code Pebbles emails (same as the web app).
2. **Freelancer-gated**: only an employee who has an active freelancer policy may use it. Anyone else
   is refused (the API returns 404 for `/api/employee/freelancer/policy`).
3. **Consent first**: on first launch it shows a consent screen and, while running, a visible
   recording indicator. It never records when switched off.
4. **Tracking**: Start begins a session; every 30 minutes it captures the primary screen, uploads it
   to Cloudinary using a **signed ticket the API issues** (the app holds no secret), and records the
   URL against the session. Stop ends the session.

Freelancers still enter their own hours in Pebbles under **My Work**; the screenshots and tracked
times are what their admin reviews against those hours.

## Security / privacy

- The app talks only to the Pebbles API, and to the exact Cloudinary upload URL the API signs for a
  single upload. It holds **no database connection and no Cloudinary secret**.
- The access token lives in memory only; it is gone when the app closes. The only thing persisted is
  the one-time consent flag.
- Monitoring is disclosed and consented, never hidden (ADR 0023, NDPA).

## Configure

The API base URL defaults to staging (see `src/config.js`). Override per environment:

```
CROWTHERWATCH_API_URL=https://<pebbles-api-host>
```

## Develop & build

```
npm install
npm start            # run the app locally
npm run dist:win     # build a Windows installer   (run on Windows)
npm run dist:mac     # build a macOS .dmg           (run on macOS)
npm run dist:linux   # build Linux AppImage/.deb    (run on Linux)
```

Each OS's installer is built on that OS (or in CI). Every installer is self-contained — Electron
bundles its own runtime, so a user installs one file and it runs; there is nothing else to install.
