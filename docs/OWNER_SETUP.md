# What the pipeline needs from you

Everything in one place. Each item switches on the part named beside it.

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
4. Set `HEALTHCHECK_URL` and keep the Discord webhook (section 4).
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
- **healthchecks.io** (`HEALTHCHECK_URL`): the free plan allows 20 checks. One check tells you when
  the server itself is down. Keep the Discord webhook (`ALERT_DISCORD_WEBHOOK`) in `.env` too, since
  alerts go there. Add a second check for `HEALTHCHECK_DAILY_URL`: period 1 day, grace about
  3 hours. The pipeline pings it only after the daily summary has been delivered, so a day without a
  ping means the summary never arrived.
- **A server** (Phase 7): Ubuntu 24.04, 4 vCPU, 8 GB, your SSH key on it, about $10–17 a month.
- **Backups** (Phase 7): section 5.

## 5. Backups (Cloudflare R2)

The `backup` service copies the nightly database snapshot and `data/clips` to R2, encrypted with
restic. It idles until `.env.backup` names a repository. Its secrets stay out of `.env`.

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

## Not needed any more

- `HIGGSFIELD_KEY_ID` and `HIGGSFIELD_KEY_SECRET`. The REST API bills a separate prepaid balance
  (D-30). You can delete the key in the Higgsfield console.
- YouTube, Meta and TikTok developer apps. Everything posts through the bridge (D-29).
- `FAL_KEY`. No fal.ai model is used.
