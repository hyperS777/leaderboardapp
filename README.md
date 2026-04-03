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

## Deployment to Cloudflare Pages

### Prerequisites
- Cloudflare account
- Node.js installed
- `wrangler` CLI (`npm install -g @cloudflare/wrangler`)

### Setup Instructions

1. **Create a D1 database:**
   ```bash
   wrangler d1 create leaderboard-db
   ```
   Copy the database ID from the output.

2. **Initialize the schema:**
   ```bash
   wrangler d1 execute leaderboard-db --file D1_SCHEMA.sql
   ```

3. **Configure wrangler.toml:**
   - Copy `wrangler.example.toml` to `wrangler.toml`
   - Replace `YOUR_DATABASE_ID` with your actual database ID
   - Update the `PASSWORD_HASH` if you changed the admin password

4. **Deploy:**
   ```bash
   wrangler deploy --env production
   ```

### Important Notes

**Without D1 setup, data only saves locally in each browser.** When opening the app in a different browser/device, you'll see the default data because there's no server database.

The console logs will show:
- ✓ "Loaded state from API" = Data is from the server (shared across all browsers) ✅
- ⚠ "Falling back to local state" = Data is only in this browser ❌

To make data visible across browsers, you **must** complete the D1 setup above.
