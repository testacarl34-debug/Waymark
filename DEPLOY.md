# Deploy Waymark (free, permanent URL)

This project is a zero-dependency Node server (`node server.js`). It works on
any host that runs Node 22.5+ and gives you a persistent disk for `waymark.db`.

## What you need first
1. A **GitHub** account (free) — to hold the code.
2. A **Render** account (free) at https://render.com — sign up *with GitHub*.

## Step 1 — push this code to GitHub
```bash
# in this folder
git remote add origin https://github.com/<YOUR-USERNAME>/waymark.git
git branch -M main
git push -u origin main
```
(Create the empty `waymark` repo at https://github.com/new first — no README.)

## Step 2 — deploy on Render
1. Render dashboard → **New +** → **Web Service** → pick your `waymark` repo.
2. Render auto-detects Node. Confirm:
   - **Build command:** *(leave empty — no build needed)*
   - **Start command:** `node server.js`
3. Add a **persistent disk** (keeps your database across deploys):
   - In the service → **Disks** → **Add Disk**
   - Name: `waymark-data`, Mount path: `/opt/render/project/src`, Size: 1 GB
     (the free tier allows one small disk; mounting at the project dir keeps
     `waymark.db` where the server writes it)
4. Click **Deploy**. Render builds and gives you a permanent URL like
   `https://waymark.onrender.com`.

That's it — that URL stays up and survives restarts. Share that one.

## Notes
- Render's free web service sleeps after ~15 min of no traffic; the first visit
  after idle takes ~30–60s to wake (then it's fast). A $7/mo plan removes this.
- Environment variables: none required. `PORT` is set by Render automatically.
- To update the site later: `git push` and Render redeploys automatically.

## Other free hosts (same steps, similar)
- **Fly.io** — `fly launch` (needs their CLI + a card on file for free tier)
- **Railway** — connect repo, add a volume; free trial credit
- **A $5 VPS** (Hetzner/DigitalOcean) — full control, run `start.sh` under systemd
