# What the pipeline needs from you

Everything in one place. Nothing here blocks the work in progress: rendering and the scheduler are
being built against stubs, and each item switches on the part named beside it.

**Put secrets in the `.env` file, not in chat.** Copy `.env.example` to `.env` and fill in the
variable named in each step.

## 1. Four decisions

| # | Question | Recommended | Why it matters |
|---|---|---|---|
| 1 | **TikTok.** Use a hosted bridge, or finish each post by hand from TikTok's drafts? | Bridge | TikTok does not audit a tool that posts to your own account, so your own app can only post privately. A bridge is the only unattended route to public posts. See `PLATFORMS.md` |
| 2 | **LinkedIn.** Company Page through the same bridge, Company Page directly, or your personal profile? | Company Page through the bridge | Direct Page posting needs LinkedIn to approve an app for a registered legal entity. A personal profile works today and must be re-authorized every 60 days |
| 3 | **Does Merry Marts have three or fewer employees?** | — | Remotion, the render engine, is free up to three. Above that it costs at least $100 a month and the plan changes |
| 4 | **Claims printed on your product photos** ("three heat levels", "machine washable", "10,000 mAh"). May ads state them? | No. Add the true ones to the Shopify description | The description lists few facts, and the pipeline only states what the store data says. The photos are supplier graphics and one shows a power bank that is not included |

For decision 4 the most useful thing you can do is edit the product description in Shopify and add
what is true: number of heat settings, warm-up time, how it is powered, washing instructions,
shipping time. Every fact you add becomes material for hooks and scripts.

## 2. One switch on this machine

Docker Desktop → Settings → Resources → WSL integration → enable it for this Ubuntu distro. Docker
is installed on Windows and switched off for WSL, so `docker compose up` cannot be tested here yet.

## 3. Keys

| What | Variable in `.env` | Needed for | Notes |
|---|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY` | Scripts, captions, QA | In the Anthropic Console, set the workspace spend limit to $10 a month |
| Alert destination | `ALERT_DISCORD_WEBHOOK`, or `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` | Failure alerts and the daily summary | A Discord webhook takes one minute: channel settings → Integrations → Webhooks |
| healthchecks.io | `HEALTHCHECK_URL`, `HEALTHCHECK_DAILY_URL` | Telling you when the VM itself is down | Free account, two checks: one with a 5-minute period, one daily |
| Bridge API key | `BRIDGE_API_KEY` | TikTok, and LinkedIn if you choose it | [Zernio](https://zernio.com/pricing): first two connected accounts free. Connect TikTok and the LinkedIn Page there |
| fal.ai key (optional) | `FAL_KEY` | Tier 1 AI clips | Prepay at most $15 and leave auto-reload off |
| Higgsfield API key (optional) | `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET` | Tier 2 AI clips | Prepay at most $25 and leave auto-reload off |
| Shopify app (optional) | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Reliable product sync | Shopify Dev Dashboard → create an app → Admin API scope `read_products` → install on the store. Without it the pipeline reads the public product feed, which rate-limits |
| Cloudflare R2 (Phase 7) | `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Encrypted backups | Free tier. Keep a copy of the restic password somewhere other than the VM |

Without the two optional clip keys the pipeline makes Tier 0 ads only, which cost nothing.

## 4. Platform accounts

Each needs a developer app that belongs to you. The store's own policy pages work for the privacy
and terms URLs: `https://shopgiftwell.myshopify.com/policies/privacy-policy` and
`/policies/terms-of-service`.

**YouTube (15 minutes).** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`
1. In Google Cloud Console create a project. Enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: External, then set the publishing status to **In production**. In "Testing" the login expires every 7 days.
3. Create an OAuth client of type **Desktop app**.

**Facebook (15 minutes).** `META_APP_ID`, `META_APP_SECRET`, `META_PAGE_ID`
1. At developers.facebook.com create an app of type Business.
2. Leave it in Development mode for the test post. Switching it to Live later makes posts public.
3. The login step will ask you for a token from Graph API Explorer with `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`.

**TikTok (20 minutes).** `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
1. For public posting: connect the TikTok account in the bridge. Nothing else.
2. For the private test post: at developers.tiktok.com create an app with **Login Kit** and **Content Posting API**, add the Desktop redirect `http://localhost:8765/callback/`, create a **Sandbox** and add your TikTok account as a target user. Use the sandbox key and secret.

**LinkedIn (10 minutes).** `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- Through the bridge: connect the Company Page there. No developer app.
- Personal profile: create a developer app and add the **Share on LinkedIn** product.
- Company Page directly: create a separate app and request the **Community Management API**. It must be the only product on that app.

The one-time login commands (`pipeline auth youtube` and so on) arrive with Phase 5. This page will
be updated with them.

## 5. Brand

Any of these you have. Defaults are derived from the product photos where you have nothing.

- Logo (SVG or PNG with transparency).
- Brand colours as hex codes, and fonts if you use particular ones.
- Voice: three words for the tone, and whether the narrator should sound female or male.
- Your handles on each platform, hashtags you always use, and words to avoid.
- Preferred call to action ("Shop now", "Link in bio", something else).

## 6. A server (Phase 7)

A VM with Ubuntu 24.04, 4 vCPU and 8 GB, and your SSH key on it. About $10–17 a month. The shortlist
and current availability are in `COSTS.md`. You create the account. The setup script does the rest.
