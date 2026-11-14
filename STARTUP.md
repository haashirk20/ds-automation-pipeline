# Startup guide

How to run, host and use the ad pipeline. `docs/OWNER_SETUP.md` is the detailed reference. This
guide links to its sections instead of repeating them. Anything marked **unverified** was not
confirmed against the code or a live run.

## 1. What this is

- One Shopify product goes in. Two 15-second vertical ads a day are posted to YouTube Shorts and
  TikTok (Facebook and Instagram are switched off in `config/pipeline.config.ts`).
- `pipeline` does the work: it plans slots, writes the concept, makes the clip on your Higgsfield
  credits, checks it and posts through the Zernio bridge. It runs a tick once a minute.
- `admin` is a small web page for changing settings and prompts. It holds no API keys in its environment, but it can read the database file that holds the OAuth tokens.
- `backup` copies an encrypted nightly snapshot to Cloudflare R2. It idles until `.env.backup` names a repository.
- Data lives in Docker named volumes: `pipeline-data` (database, tokens, stored clips),
  `pipeline-out` (renders) and `backup-status`.
- Cost per month (`docs/COSTS.md`): Higgsfield $65 flat, VM $10-17, Anthropic about $2 (capped at
  $10), bridge $0 with two platforms ($12 with four), the rest free. Total now $77-84.

## 2. Run it locally (WSL2 + Docker Desktop)

Work inside the WSL terminal. Turn on Docker Desktop's WSL integration for your distro.

```bash
git clone <your-repo-url> automated_upload_pipeline && cd automated_upload_pipeline
```

Create the two env files. Fill `.env` (keys are listed in `.env.example`) and `.env.backup`
(Cloudflare R2, see `docs/OWNER_SETUP.md` section 5).

```bash
cp .env.example .env && cp .env.backup.example .env.backup && chmod 600 .env .env.backup
```

```bash
docker compose build
```

The first build is slow: it downloads Chrome and a voice model.

**Sign in to Higgsfield.** The sign-in is stored in the database in the `pipeline-data` volume, so
do it through the container:

```bash
docker compose run --rm pipeline node src/cli.ts auth higgsfield
```

It prints a link and listens on 127.0.0.1:53682 inside the container. `compose.yaml` does not
publish that port, so your browser cannot hand the result back by itself. Use the paste fallback:

1. Open the printed link in your browser, sign in and approve.
2. The browser then lands on a `http://127.0.0.1:53682/callback?...` page that fails to load. That is expected.
3. Copy the whole address from the address bar, paste it into the terminal and press Enter.
4. The command ends with `signed in: plan ultra, <n> credits`. It waits 10 minutes at most.

`docs/OWNER_SETUP.md` section 1 says the same. If the run is not interactive (no TTY), the paste
step may not work. This was not tested through `docker compose run`: **unverified**. You already
signed in on 2026-11-14, but that token is in your current database. A fresh volume needs this step again.

Start everything:

```bash
docker compose up -d
```

```bash
docker compose ps
```

```bash
docker compose logs -f pipeline
```

```bash
docker compose run --rm pipeline node src/cli.ts doctor
```

`doctor` checks the config, the database, that the secrets are present, the Higgsfield sign-in and
the heartbeat. Read every line.

**DRY_RUN.** The default is `DRY_RUN=1` (compose sets it unless `.env` or your shell says otherwise).
A dry run posts nothing, but it still calls the models and still spends Higgsfield credits and
Anthropic money. To post for real, set `DRY_RUN=0` in `.env`, then:

```bash
docker compose up -d
```

All platforms start with `visibility: 'private'` (YouTube private, TikTok a draft in your inbox).
Look at the first posts there. Make them public in the admin page (section 3) when you are happy.

## 3. The admin page

Set the password once (at least 12 characters). Run it again to change it, which logs everyone out.

```bash
docker compose run --rm --no-deps admin node src/cli.ts admin password
```

Open http://localhost:8080 (or your `ADMIN_PORT`) and log in as `admin`. Sessions end after 60 idle
minutes or 12 hours.

Pages: **Overview** (state, "version N in use", items needing attention), **Activity** (slots and
publications), **Settings**, **Prompts** and **History** (versions and audit log).

**Editable:** slot times and count, which platforms are on (all off pauses the pipeline),
visibility, the video preset and lower caps, the model cap, the models for the concept writer and
checks, the `ugc`, `copy`, `hooks`, `script`, `video` and `house` prompts, per-product notes and
retention. A value in `config/pipeline.config.ts` is a ceiling: the page can lower it, never raise it.

**Locked** (edit the file instead): the `claims`, `copycheck` and `vision` prompts, publish and
disclosure settings, account handles, `DRY_RUN`, timezone, render settings and brand. Secrets are never shown.

**When a change applies.** A save makes a new numbered version after a diff page. The pipeline reads
it at the start of the next tick, within a minute. A slot already in production finishes on the old
version. New slot times apply from the first day not yet planned.

**Roll back:** History, then Activate on an older version. "Use file" on the History page resets all
settings to the file; for one prompt it resets that prompt; a single setting goes back by entering the file
value. Details: `docs/OWNER_SETUP.md` section 6.

**Login note.** The form checks that the browser's `Origin` matches the address you opened. Open the
page on one address (for example `localhost:8080`) and stay on it. Mixing `127.0.0.1` and
`localhost`, or a proxy that rewrites the host, makes login fail.

## 4. Host it on a VM

**Pick a provider.** D-13 in `docs/DECISIONS.md`: any Ubuntu 24.04 VM, x86 or ARM64. Shortlist,
in order: Hetzner CX33 or CAX21 (about $10-12, often sold out), Netcup VPS 1000 (about $16),
Hostinger KVM 2 ($9-15). Size: 4 vCPU, 8 GB RAM and 40 GB disk is comfortable. 2 vCPU / 4 GB with
swap is the floor. Skip Oracle Always Free: it reclaims idle instances.
There is no setup script: follow the steps below.

**Install Docker Engine** from Docker's apt repository. Follow the official steps for Ubuntu at
https://docs.docker.com/engine/install/ubuntu/ ("Install using the apt repository"). They add
Docker's signing key and apt source, then:

```bash
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Optionally let your user run Docker without sudo (log out and in afterwards):

```bash
sudo usermod -aG docker $USER
```

**Copy the project.** Clone the repository on the VM (section 5 needs `git pull`), then `scp` the two env files, which are not in git.

```bash
git clone <your-repo-url> ~/automated_upload_pipeline
```

```bash
scp .env .env.backup <user>@<vm>:~/automated_upload_pipeline/
```

On the VM:

```bash
chmod 600 ~/automated_upload_pipeline/.env ~/automated_upload_pipeline/.env.backup
```

**Database.** Either start fresh and run `auth higgsfield` again (section 2), or restore from the
R2 backup with the runbook in `docs/OWNER_SETUP.md` section 5 (the restore also needs `after-restore`).
Copying the volume by hand was not tested: **unverified**.

```bash
cd ~/automated_upload_pipeline && docker compose build && docker compose up -d
```

**Firewall: SSH only.** The admin port is already bound to 127.0.0.1, so nothing else is exposed.
Allow SSH before enabling, or you lock yourself out.

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow OpenSSH && sudo ufw enable
```

Docker publishes ports by editing iptables directly, which `ufw` does not filter. The compose file
publishes only on 127.0.0.1, so this does not matter here. Do not add public `ports:` entries.

**SSH keys only.** Install your key first (`ssh-copy-id <user>@<vm>`), test a second login, then set
`PasswordAuthentication no` in a file under `/etc/ssh/sshd_config.d/` and reload SSH:

```bash
sudo systemctl reload ssh
```

**Reach the admin page.** Tunnel from your laptop, leave it running and open http://localhost:9000:

```bash
ssh -L 9000:127.0.0.1:8080 <user>@<vm>
```

Or use Tailscale on the VM and laptop. The command is **unverified**, check `tailscale serve --help`, and login over https was not tested on a real tailnet:
`tailscale serve --bg 8080`. Put the MagicDNS name in `ADMIN_HOSTS` in `.env` and run
`docker compose up -d admin`. See `docs/OWNER_SETUP.md` section 6.

## 5. Day to day

**Discord.** Alerts arrive as they happen (examples: `publish_needs_attention`, `produce_failed`,
`clip_sign_in`, `budget_cap`, `disk_full`, `snapshot_failed`, `config_invalid`, `admin_lockout`).
The daily summary for yesterday arrives after 08:00 (`ops.summaryAt`, local time).

**Healthchecks.** "Pipeline tick" down: nothing is running, so check `docker compose ps` and
`docker compose logs pipeline`. "Daily summary" down: the summary was not delivered, so test the
Discord webhook. The pipeline may still be posting. Setup is in `docs/OWNER_SETUP.md` section 7.

**`needs_attention`.** The pipeline could not tell whether a post went out (or was restored from a
backup). It never re-posts these on its own. Open the platform (YouTube Studio, TikTok inbox),
check whether the post exists, and only then resolve the publication by hand. The Overview page
shows the count and Activity lists them. Do not clear one without looking at the platform first.

**Update:**

```bash
git pull && docker compose build && docker compose up -d
```

**Backups** run nightly after 03:30 local time. `docker compose logs backup` shows `backup ok`.
Restore runbook: `docs/OWNER_SETUP.md` section 5. Keep the restic password off the VM.

**Stop:**

```bash
docker compose down
```

Warning: `docker compose down -v` deletes the data volumes: the database, the Higgsfield sign-in,
stored clips and the admin password. Never run it unless you mean it.

## 6. Troubleshooting

- **Admin login returns "Forbidden".** Fixed on 2026-11-14: the browser was sending `Origin: null`.
  If it comes back, open the page on exactly the host name and port in the address bar you
  logged in from, and make sure `ADMIN_HOSTS` lists any non-localhost name.
- **"Misdirected request" (HTTP 421).** The host name is not allowed. Add it to `ADMIN_HOSTS` in
  `.env`, then `docker compose up -d admin`. `127.0.0.1`, `localhost` and `[::1]` are always accepted.
- **Higgsfield sign-in expired.** You get a `clip_sign_in` alert and slots fall back to stored
  clips. Repeat the sign-in from section 2.
- **Budget cap reached.** A `budget_cap` alert means the monthly model cap (`llm.monthlyCapUsd`,
  $10) or a video cap (`tiers.capsUsd.t2`, $52) was hit. Calls or new clips stop until the next
  calendar month. Raising a cap means editing `config/pipeline.config.ts` (the admin page can only
  lower it). Details: `docs/COSTS.md`. The pipeline also stops new videos when the Higgsfield
  balance would fall under 350 credits.
- **No stored clip in the first two weeks.** A stored clip can be posted again only after
  `ugc.reuseAfterDays` (14) days. If a new clip cannot be made (no credits, sign-in expired) and
  no clip is old enough, the slot fails with "no new clip could be made and no stored clip can be
  posted again". Fix the cause, then the slot is retried or the next day plans a new one.
- **Anything else.** `docker compose logs --tail 200 pipeline` (one JSON object per line) and
  `doctor`.
