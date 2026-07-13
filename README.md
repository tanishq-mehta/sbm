# SBM User Manager

A small full-stack app for searching and editing the user records imported from `TEAM 1` through `TEAM 6` in `/Users/tmehta/Downloads/SBM.xlsx`.

The six sheets are treated only as import sources. Records are stored and shown as one combined directory with no team-wise distinction.

## Stack

- React + Vite frontend
- Node HTTP API backend
- Supabase/Postgres when `DATABASE_URL` is configured
- SQLite fallback using Node 22's built-in `node:sqlite`
- Seed data generated into `data/people-seed.json`

## Login

- Username: `admin`
- Password: `123456`

## Run Locally

```bash
npm install
npm run dev
```

If npm reports a permissions issue with `~/.npm`, use:

```bash
npm install --cache /Users/tmehta/prc/.npm-cache
```

Open `http://127.0.0.1:5173/`.

## Useful Commands

```bash
npm run build
npm run server
npm run db:migrate
npm run db:seed
npm run seed
npm run import:excel
```

`npm run db:migrate` creates the database schema for the active database.

`npm run db:seed` imports `data/people-seed.json` into the active database.

`npm run seed` is an alias for `npm run db:seed`.

`npm run import:excel` regenerates `data/fields.json` and `data/people-seed.json` from the Excel workbook. It expects `pandas` to be available in Python.

## Supabase Setup

1. In Supabase, open the project and click **Connect**.
2. Copy a Postgres connection string. For this backend, use the **Session pooler** connection if available. The direct connection also works when your network supports IPv6.
3. Create `/Users/tmehta/prc/.env` from `.env.example`.
4. Paste the real connection string as `DATABASE_URL`.
5. Run:

```bash
npm run db:migrate
npm run db:seed
npm run server
```

Check the active database:

```bash
curl http://127.0.0.1:4000/api/health
```

It should return `"database":"postgres"` when Supabase is active.

## Database Notes

SQLite is the easiest fit for this record count. The app stores the original workbook fields as JSON in SQLite, while keeping summary fields such as name, badge number, department, and phone number in separate columns for search results.

For a deployed production-style app, use Supabase/Postgres instead of SQLite unless the host provides durable disk storage. Free web services often use temporary filesystems, so SQLite edits can disappear after redeploys or restarts.

## Vercel Deployment

This project is ready for Vercel with Supabase/Postgres as the production database.

1. Push the project to GitHub.
2. Go to Vercel and import the GitHub repo.
3. Keep the framework preset as **Vite**.
4. Use these build settings:

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```

5. Add these environment variables in Vercel:

```bash
DATABASE_URL=your_supabase_connection_string
DATABASE_SSL=true
DATABASE_POOL_MAX=3
```

6. Deploy.

The React frontend is served from `dist/`. The backend API runs through the Vercel function at `api/[...path].mjs`, so existing routes such as `/api/login`, `/api/people`, and `/api/export/people.xlsx` stay the same.

## Traditional Node Deployment

For hosts that run a long-lived Node server, use:

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

The Node server serves the built frontend from `dist/` and the API from `/api`.
