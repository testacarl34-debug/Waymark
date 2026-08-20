# Deploy Waymark (free, permanent, no data loss)

Stack: **Render** (runs the app, free) + **Turso** (hosts the database, free,
never wiped, no credit card). The app stores everything in Turso, so it
survives Render restarts and redeploys.

Your Turso database is already created. You need these two values (keep them secret):
- `TURSO_DATABASE_URL` = `libsql://waymark-testacarl34-debug.aws-us-east-1.turso.io`
- `TURSO_AUTH_TOKEN`  = the long database token (from `turso db tokens create waymark`)

## One-time: push code to GitHub
```bash
git remote add origin https://github.com/<YOU>/Waymark.git
git push -u origin main
```

## Deploy on Render
1. https://dashboard.render.com → **New +** → **Web Service** → connect the `Waymark` repo.
2. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** Free
3. **Environment variables** (Environment tab → Add):
   - `TURSO_DATABASE_URL` = `libsql://waymark-testacarl34-debug.aws-us-east-1.turso.io`
   - `TURSO_AUTH_TOKEN` = *(your database token)*
4. **Create Web Service.** In ~2 min you get `https://<name>.onrender.com`.

No disk needed — the database lives in Turso, not on Render.

## Notes
- Render free tier sleeps after ~15 min idle; first visit after that takes ~30–60s
  to wake. Your data is safe in Turso regardless.
- `npm install` is required now because the app uses `@libsql/client`.
- To update: `git push`, Render redeploys automatically.
- If `TURSO_*` env vars are absent, the app falls back to a local `waymark.db`
  file (fine for local dev, not for hosting).

## Regenerate the database token if needed
```bash
turso db tokens create waymark
```
