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

## 1. Sign the pipeline in to Higgsfield (2 minutes, needed before any video is made)

Videos are generated on your Higgsfield subscription credits. The pipeline signs in the way an
assistant app does, once:

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
- **healthchecks.io** (`HEALTHCHECK_URL`, `HEALTHCHECK_DAILY_URL`): a free account with two checks
  tells you when the server itself is down.
- **A server** (Phase 7): Ubuntu 24.04, 4 vCPU, 8 GB, your SSH key on it, about $10–17 a month.
- **Backups** (Phase 7): Cloudflare R2 keys, `RESTIC_*` and `AWS_*` in `.env`.

## Not needed any more

- `HIGGSFIELD_KEY_ID` and `HIGGSFIELD_KEY_SECRET`. The REST API bills a separate prepaid balance
  (D-30). You can delete the key in the Higgsfield console.
- YouTube, Meta and TikTok developer apps. Everything posts through the bridge (D-29).
- `FAL_KEY`. No fal.ai model is used.
