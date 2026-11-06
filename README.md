# Out Of Office Pace — Race Calendar Edition

A local-first race registration and medal tracker. It is designed to complement Amazfit/Strava rather than duplicate run tracking.

## Features
- Race calendar for upcoming, past, interested, completed and cancelled events
- Multi-day race windows stored as one registration with a start and end date
- Multiple distinct race entries on the same date, grouped together and clearly flagged
- Booking site, organiser, confirmation/order ID, amount paid, BIB number and confirmation URL
- Search and filters for all/upcoming/past races
- Medal cabinet
- JSON export/import backup
- Local browser storage with Dexie/IndexedDB
- Installable PWA with offline app shell

## Run locally
1. Install Node.js LTS.
2. Extract this folder and open it in VS Code.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the local URL printed in the terminal (normally http://localhost:5173).

Your existing race and medal records from the first starter are retained because the database uses a versioned migration. Activity and goal records are not shown in this race-focused interface. Export a backup regularly; records are stored in this browser on this device.

When importing a backup, repeated versions of a race in the same file are merged so details and photos are retained. Multi-day windows are normalized to one race entry, even when one backup row uses its end date as the race date. Existing races default to **Skip**; choose **Merge backup details** in the preview to restore non-empty backup details and photos without clearing saved fields. If several saved entries match the same event, choosing merge consolidates them into one entry while retaining their non-empty details and photos.

The overview's completed-race distance and annual progress ring include completed races only. Upcoming registrations are shown separately and do not inflate completed kilometres.

## Deploy to GitHub Pages
The GitHub Actions workflow in `.github/workflows/deploy.yml` builds and deploys the app when code is pushed to `main` or `master`. It derives the Vite base path from the repository name, so project Pages sites work without a repository-specific config change.

1. Create a GitHub repository and push this project to its `main` or `master` branch.
2. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. Wait for the **Deploy to GitHub Pages** workflow to finish. Its deployment environment links to the published site.

For the account-level site, name the repository `yogiccloud.github.io`; other repository names are published under `https://yogiccloud.github.io/<repository-name>/`. This app stores race data in the visitor's browser, not in GitHub or a server. Keep private backups such as `backup.json` out of the repository.
