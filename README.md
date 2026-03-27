# Quiz Leaderboard

Live site: `https://leaderboardapp.pages.dev/`

## What it is

A simple leaderboard web app with:
- Viewer mode (read-only)
- Admin mode (edit teams, members, scores; export to Excel)

Admin changes are saved to a shared Cloudflare D1 database via a Pages Function at `/api/state`, so anyone with the link sees the same data after refresh.

## Project structure

- `index.html` – app entry
- `style.css` – styling
- `app.js` – UI + client logic
- `vendor/xlsx.full.min.js` – SheetJS library for Excel export
- `functions/api/state.js` – Cloudflare Pages Function (GET/POST shared state)
- `D1_SCHEMA.sql` – D1 table schema

## Cloudflare (Pages + D1) setup

1. Create a **Cloudflare Pages** project from this repo (Framework: **None**, Output dir: `/`).
2. Create a **D1** database and run `D1_SCHEMA.sql` in the D1 SQL editor.
3. In the Pages project, add a **D1 binding** named `DB` pointing to that database.
4. Redeploy the Pages project.

## Notes

- The admin password is set in `app.js` and `functions/api/state.js`.
- Viewers may need to refresh the page to see the latest changes.

