# What the pipeline needs from you

Everything in one place. Nothing here blocks the work in progress: each item switches on the part
named beside it.

**Put secrets in the `.env` file, not in chat.** Copy `.env.example` to `.env` and fill in the
variable named in each step. A `.env` with the store domain and `DRY_RUN=1` already exists.

## Settled

- Docker works in this WSL distro.
- Giftwell has three employees, so Remotion is free.
- TikTok posts go through a hosted bridge.
- The fourth platform is Instagram Reels.

## 1. One open question

**Claims printed on your product photos** ("three heat levels", "machine washable", "10,000 mAh").
The description in Shopify does not make them, so ads do not state them. One photo shows a power
bank that is not included.

The most useful thing you can do is edit the product description in Shopify and add what is true:
number of heat settings, warm-up time, how it is powered, washing instructions, shipping time.
Every fact you add becomes material for hooks and scripts. The store is also still called
"Merry Marts" in a few of the supplier photos' captions, if that matters to you.

## 2. Keys

| What | Variable in `.env` | Needed for | Notes |
|---|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY` | Scripts, captions, QA | In the Anthropic Console, set the workspace spend limit to $10 a month |
| Alert destination | `ALERT_DISCORD_WEBHOOK`, or `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` | Failure alerts and the daily summary | A Discord webhook takes one minute: channel settings → Integrations → Webhooks |
| healthchecks.io | `HEALTHCHECK_URL`, `HEALTHCHECK_DAILY_URL` | Telling you when the VM itself is down | Free account, two checks: one with a 5-minute period, one daily |
| Bridge API key | `BRIDGE_API_KEY` | Public TikTok posts | [Zernio](https://zernio.com/pricing) lists its first two connected accounts as free. Connect the TikTok account there |
| fal.ai key (optional) | `FAL_KEY` | Tier 1 AI clips | Prepay at most $15 and leave auto-reload off |
| Higgsfield API key (optional) | `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET` | Tier 2 AI clips | Prepay at most $25 and leave auto-reload off. Your subscription's credits may be usable instead: that is checked in Phase 4 |
| Shopify app (optional) | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Reliable product sync | Shopify Dev Dashboard → create an app → Admin API scope `read_products` → install on the store. Without it the pipeline reads the public product feed, which rate-limits |
| Cloudflare R2 (Phase 7) | `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Encrypted backups | Free tier. Keep a copy of the restic password somewhere other than the VM |

Without the two optional clip keys the pipeline makes Tier 0 ads only, which cost nothing.

## 3. Platform accounts

The store's own policy pages work for the privacy and terms URLs the developer portals ask for:
`https://shopgiftwell.myshopify.com/policies/privacy-policy` and `/policies/terms-of-service`.

**YouTube (15 minutes).** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`
1. In Google Cloud Console create a project. Enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: External, then set the publishing status to **In production**. In "Testing" the login expires every 7 days.
3. Create an OAuth client of type **Desktop app**.

**Facebook and Instagram (20 minutes, one app for both).** `META_APP_ID`, `META_APP_SECRET`, `META_PAGE_ID`
1. Make the Instagram account a professional account (Business or Creator) and link it to the Facebook Page.
2. At developers.facebook.com create an app of type Business.
3. Leave it in Development mode for the test. Switching it to Live later makes Facebook posts public.
4. The login step will ask for a token from Graph API Explorer with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic` and `instagram_content_publish`.
5. Put the store link in the Instagram bio. Links in Instagram captions are not clickable.

**TikTok (10 minutes).** `BRIDGE_API_KEY`
1. Connect the TikTok account in the bridge.
2. Put the store link in the TikTok bio.
3. Optional, for a private test through your own app: at developers.tiktok.com create an app with **Login Kit** and **Content Posting API**, add the Desktop redirect `http://localhost:8765/callback/`, create a **Sandbox** and add your TikTok account as a target user. `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.

The one-time login commands (`pipeline auth youtube`, `pipeline auth meta`) arrive with Phase 5.
This page will be updated with them.

## 4. Brand

Any of these you have. Defaults are derived from the product photos where you have nothing.

- Logo (SVG or PNG with transparency).
- Brand colours as hex codes, and fonts if you use particular ones.
- Voice: three words for the tone, and whether the narrator should sound female or male.
- Your handles on each platform, hashtags you always use, and words to avoid.
- Preferred call to action ("Shop now", "Link in bio", something else).

## 5. A server (Phase 7)

A VM with Ubuntu 24.04, 4 vCPU and 8 GB, and your SSH key on it. About $10–17 a month. The shortlist
and current availability are in `COSTS.md`. You create the account. The setup script does the rest.

## 6. Optional

Sign in to the Shopify connector in Claude's connector settings. It is present in the session but
not authenticated. It is a convenience for checking store data during the build, and the pipeline
does not use it.
