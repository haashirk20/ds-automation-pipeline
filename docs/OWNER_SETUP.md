# What the pipeline needs from you

Everything in one place. Each item switches on the part named beside it. For running and hosting the stack, see `STARTUP.md`.

**Put secrets in the `.env` file, not in chat.** `.env.example` lists every variable.

## Done

- Docker works in this WSL distro.
- Giftwell has three employees, so Remotion is free.
- In `.env`: the Anthropic key, the Discord webhook, the Shopify app credentials (`read_products`)
  and the bridge key.
- YouTube (`shopgiftwell`) and TikTok (`merrymarts`) are connected at the bridge.
- The logo is in `config/brand/logo.png`. Two reference videos set the style (D-28).
- The pipeline is signed in to Higgsfield (2026-11-14, section 1).

## To do now

1. Discard the test draft in the TikTok inbox and delete the private YouTube test video. Both came
   from the test posts of 2026-11-13.
2. Choose the video model: look at `out/samples/ugc-wan30.mp4` and `out/samples/ugc-seedance.mp4`.
   Wan 3.0 is the default and costs 26.25 credits a clip. Seedance 2.0 fast costs 37.5. The frame
   check of 2026-11-14 passed the Wan clip and was split on the Seedance clip, because of a
   hood-like collar.
3. Confirm `config/product-notes.json` (section 4).
4. Set `HEALTHCHECK_URL` and `HEALTHCHECK_DAILY_URL` (section 7) and keep the Discord webhook (section 4).
5. Optional: connect Facebook and Instagram (section 2).

## 1. Sign the pipeline in to Higgsfield (done 2026-11-14)

Videos are generated on your Higgsfield subscription credits. The pipeline signs in the way an
assistant app does. The token was refreshed on 2026-11-14. Run this again only if an alert says
the sign-in expired:

```bash
node src/cli.ts auth higgsfield
```

It prints a link. Open it, sign in to Higgsfield and approve. On this machine the browser hands
the result back by itself. On a server reached over SSH, the browser ends on a page that fails to
load: copy the whole address from the address bar, paste it into the terminal and press Enter.
The command finishes with `signed in: plan ultra, <n> credits`.

On the server, inside Docker:

```bash
docker compose run --rm pipeline node src/cli.ts auth higgsfield
```

If the sign-in ever expires you get an alert that names this command.

**Credits.** Your plan grants 3,000 credits a month and unused ones are removed at renewal. A video
costs 26.25 credits on the default model, so 60 videos use about 1,575. The pipeline stops making
new videos when the balance would drop below 350 credits (`tiers.t2.keepCredits`) and reuses
stored ones. That floor sits above Higgsfield's auto-refill threshold of 300, so the pipeline
cannot trigger an automatic purchase. Auto-refill is off on your account today.

## 2. Facebook and Instagram (5 minutes, optional)

Both are switched off in `config/pipeline.config.ts`. To switch them on:

1. Make the Instagram account a professional account and link it to the Facebook Page.
2. Connect the Facebook Page (`Merry Marts`) and the Instagram account (`shopgiftwellgifts`) at
   the bridge, the same way as YouTube and TikTok. The first two accounts are free and each
   further one is $6 a month, so this adds $12 a month.
3. Set `enabled: true` for both platforms and run `node src/cli.ts doctor`. It prints one line per
   platform: `bridge instagram: ok (...)`.
4. Set Instagram's `visibility` to `'public'` when you enable it. Instagram has no private mode,
   and the config refuses `'private'` for an enabled Instagram account.

Put the store link in the Instagram and TikTok bios. Links in their captions are not clickable.

## 3. Going public

Every platform starts at `visibility: 'private'`:

| Platform | What private does |
|---|---|
| YouTube | Uploads as a private video |
| TikTok | Sends a draft to the account's inbox in the TikTok app. You post it there, or discard it |
| Facebook | Creates a draft in Publishing Tools |
| Instagram | Has no private mode. Private is refused, so it posts nothing until set to public |

Your TikTok account is a business account, and TikTok offers those no private posts through an
app, only drafts. TikTok holds at most five pending drafts a day, so discard test drafts.

Set `visibility: 'public'` per platform when you are happy with what you see.

## 4. Still open

- **Claims printed on the product photos** ("three heat levels", "machine washable"). Shopify's
  description does not make them, so no video states them. Add what is true to the product
  description in Shopify and it becomes usable.
- **`config/product-notes.json`** says what the product looks like and visibly does. The current
  note says the power button glows red when the heat is on, as in your reference videos. Correct
  it if that is wrong.
- **healthchecks.io** (`HEALTHCHECK_URL`, `HEALTHCHECK_DAILY_URL`): section 7. Keep the Discord
  webhook (`ALERT_DISCORD_WEBHOOK`) in `.env` too, since alerts go there.
- **A server** (Phase 7): Ubuntu 24.04, 4 vCPU, 8 GB, your SSH key on it, about $10–17 a month.
- **Backups** (Phase 7): section 5.

## 5. Backups (Cloudflare R2)

The `backup` service copies the nightly database snapshot and `data/clips` to R2, encrypted with
restic. It does not copy `data/music`: keep the original music files yourself. It idles until `.env.backup` names a repository. Its secrets stay out of `.env`.

1. In Cloudflare, create an R2 bucket (for example `giftwell-backup`). R2 gives 10 GB free.
2. Create an R2 API token with Object Read & Write, scoped to that bucket only. Copy the access key
   ID and secret.
3. `cp .env.backup.example .env.backup` and fill it:
   `RESTIC_REPOSITORY=s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>`, a long random
   `RESTIC_PASSWORD`, and the two keys. Leave `AWS_DEFAULT_REGION=auto`.
4. `chmod 600 .env .env.backup`. Then delete any `RESTIC_*` and `AWS_*` lines from `.env`: the
   pipeline container reads `.env`, and those keys belong only to the `backup` service.
5. Store the restic password and the R2 keys in your password manager, off the VM. Without the
   password a backup cannot be read, and the snapshot contains the sign-in tokens.
6. `docker compose up -d`. The first backup runs when the pipeline next writes its snapshot, and
   `docker compose logs backup` then shows `backup ok`. The daily summary reports a stale backup.

**Restore** (on a new or damaged VM, with `.env` and `.env.backup` in place):

```bash
docker compose stop pipeline backup
install -d -m 700 -o 1000 -g 1000 restore
docker compose run --rm --no-deps --entrypoint sh -v "$PWD/restore:/restore" backup -c 'restic restore latest --target /restore'
docker compose run --rm --no-deps --entrypoint sh -v "$PWD/restore:/restore:ro" pipeline -c 'rm -f /app/data/pipeline.db-wal /app/data/pipeline.db-shm && cp /restore/data/backup/pipeline.db /app/data/pipeline.db && cp -r /restore/data/clips /app/data/ 2>/dev/null; true'
docker compose run --rm --no-deps pipeline node src/cli.ts after-restore
docker compose up -d
```

`after-restore` is needed because the snapshot can be a day old. A post made after it is not in
the restored database, so the pipeline would post it again. The command marks every publication
that was `pending` or `uploading` and due as `needs_attention` ("restored from backup: check the
platform before posting again"), and prints how many. Look at each platform, then resolve those
publications by hand. The old `pipeline.db-wal` and `-shm` files are removed so that stale
journal pages never replay onto the restored file.

The restored database holds the tokens as they were at backup time. Higgsfield's may be stale: if
`node src/cli.ts doctor` reports the sign-in expired, run
`docker compose run --rm pipeline node src/cli.ts auth higgsfield`. Delete `./restore` afterwards.

## 6. Admin page

A small web page for changing the schedule, the video preset, the prompts and the caps. It runs as
the `admin` service, listens on the VM's loopback only (`127.0.0.1:8080`, or `ADMIN_PORT`), and
holds none of your API keys in its environment. It can read the database file that holds the OAuth
tokens, and its environment carries the alert webhook and bot credentials. Nothing on the internet can reach it.

**Set the password** (once, at least 12 characters; run it again to change it, which logs everyone out):

```bash
docker compose run --rm --no-deps admin node src/cli.ts admin password
```

**Open it from your laptop** through an SSH tunnel:

```bash
ssh -L 9000:127.0.0.1:8080 <user>@<vm>
```

Leave that running and browse to http://localhost:9000. Log in as `admin` with the password. Sessions
end after 60 idle minutes or 12 hours. Anyone who can reach the port can trigger the global login lockout
by failing five logins; `admin password` clears it. `PIPELINE_CONFIG` is not supported together with the
admin, because the admin validates against `config/pipeline.config.ts`.

**Tailscale instead** (unverified, check `tailscale serve --help` on your version; login works over https
because the Origin check accepts `https://<host>`, but this was not tested on a real tailnet): install
Tailscale on the VM and the laptop, then on the VM run something like
`tailscale serve --bg 8080` (older versions: `tailscale serve --bg http://127.0.0.1:8080`). Put the
VM's MagicDNS name in `ADMIN_HOSTS` in `.env` (for example `vm.tailnet-name.ts.net`) and run
`docker compose up -d admin`. Without that, the page answers 421 to the name. Everyone on your
tailnet can then reach the page, and the password is the only gate.

**What you can change:** slot times, the number of slots, which platforms are enabled (all off pauses
the pipeline), visibility, the safe zone, the video preset and its lower caps, the `t0` share, the
monthly model cap, the models for the concept writer, the claim judge and the frame check, the
`ugc`, `copy`, `hooks`, `script`, `video` and `house` prompts, the per-product note, and the retention
and disk settings. A file value is a ceiling: the page can lower a cap, never raise it above
`config/pipeline.config.ts`.

**Posts.** The Posts page makes one video now. Pick a clip model (the current setting, a preset, or a
model you added) and press Make a new post. The tick makes a new paid clip, about $0.41 to $2.28 and up to
twice that if the frame check rejects the first, inside the monthly cap. When it is ready, the page
plays it and Discord or Telegram gets an alert. Nothing is posted until you press Post. Discard, or
no answer in 24 hours (`approval.expireHours`), drops it and it is never reused. Post sends it to
every enabled platform at the next tick. At most 3 posts a day (`approval.manualPerDay`) and one at a
time. More posts a day raise the repetitive-content risk on every platform. With `DRY_RUN=1` the clip is
still made and paid for, and Post sends nothing.

**Music.** The Music page takes mp3, m4a, mp4 (the picture is dropped) and wav files, up to 40 MB, 5 to
600 seconds, at most 50 tracks. Tick the ones to use. Each `ugc` video takes the ticked track used
least recently and mixes it under the clip's sound, quieter while the spoken line plays. With none
ticked there is no music. Preview and Delete are on the page. **Copyright:** only upload music you
hold the rights to use in ads. YouTube, Facebook, Instagram and TikTok scan uploads, and a match can
mute or block the post, hand its earnings to the rights holder, or strike the account. The upload form
asks you to confirm the rights for each file. **`data/music` is not backed up.** Keep the original
files.

**Models.** Four more presets appear in Settings, quoted on 2026-11-14 for a 15 s clip with no
reference images: `seedance_2_0_std_720p` 67.5 credits ($1.47), `seedance_2_5_flash_720p` 75 ($1.63),
`seedance_2_5_720p` 105 ($2.28) and `kling_o3_std` 18.75 ($0.41). At $2.28 a clip the $52 monthly cap
allows about 22 clips. The Models page adds another Higgsfield model: its id, a few options
(`resolution`, `mode`, `generate_audio`, `sound`, `bitrate_mode`, `genre`, `enable_thinking`), the
most credits one clip may cost (at most 120) and the credits to keep (at least 350). It is untested
until you use it in a Posts test post and press Post on the result. Then it can be chosen in
Settings. The live quote is checked before its first job, and a quote above your limit is refused.

**What is locked, and why.** Read-only on the page, edit the file instead:
- `claims`, `copycheck` and `vision` prompts and the frame-check effort: they are the guard against
  false claims and bad clips (D-21, D-28).
- Publish and disclosure settings, account handles, `DRY_RUN`, `timezone`: a wrong value posts to the
  wrong place, at the wrong time, or without disclosure.
- `render.*`, `watchdogMinutes`, `creative.mode`, `tiers.clipSeconds`, free-form `t2.params`
  (the Models page allows a short list of options), tier 1,
  `brand.*` and `photo-tags.json`: they tie to the renderer, the budget maths and the brand.
- Secrets and tokens are never shown.

**How a change takes effect.** Saving makes a new numbered version after a diff page. The pipeline
reads it at the start of the next tick, within a minute, and Overview then says "version N in use".
A slot already in production finishes on the old version. New slot times apply from the first day not
yet planned (the page shows the date). Slots already planned or ready keep their times, copy and
render. Visibility and enabled are read when posting.

**Before rolling the software back to an image older than 6c:** discard every waiting post on the Posts page first. Older images ignore holds, so a waiting post would be published on the next tick.

**Roll back.** History, then Activate on an older version. "Use file" on the History page resets all
settings to the file; for one prompt it resets that prompt; a single setting goes back by entering the file
value. If a stored version ever fails validation, the pipeline
uses the file config and sends a `config_invalid` alert.

## 7. Healthchecks.io

Two checks tell you when the pipeline or its alerts have stopped. The free plan allows 20 checks.

1. Create a free account at healthchecks.io.
2. Create check 1, "pipeline tick": period 5 minutes, grace 10 minutes. Copy its ping URL into
   `HEALTHCHECK_URL` in `.env`. The loop pings at the end of every tick, and a tick runs about once
   a minute (`src/scheduler/loop.ts` sleeps 60 s between ticks).
3. Create check 2, "daily summary": period 1 day, grace about 3 hours. Copy its ping URL into
   `HEALTHCHECK_DAILY_URL`. The pipeline pings it once a day, after `ops.summaryAt`, and only when
   the summary reached a real alert channel (`src/ops/summary.ts`).
4. Set the notification (email is enough) under Integrations, and make sure both checks use it.
5. `docker compose up -d` to restart the stack with the new `.env`.
6. Run `docker compose run --rm pipeline node src/cli.ts doctor`. Both URLs should show as set. Within
   a few minutes check 1 turns green. Check 2 turns green after the first summary, so it stays
   "new" until then.

What an alert means:
- **Pipeline tick is down:** nothing is running. The VM is off, Docker is stopped, or the loop is dead
  or stuck. Check `docker compose ps` and `docker compose logs pipeline`.
- **Daily summary is down:** the summary was not delivered. The alert webhook may be broken, so test
  `ALERT_DISCORD_WEBHOOK`. The pipeline may still be posting, because the tick check is green.

## Not needed any more

- `HIGGSFIELD_KEY_ID` and `HIGGSFIELD_KEY_SECRET`. The REST API bills a separate prepaid balance
  (D-30). You can delete the key in the Higgsfield console.
- YouTube, Meta and TikTok developer apps. Everything posts through the bridge (D-29).
- `FAL_KEY`. No fal.ai model is used.
