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
