# Costs

Volume: 2 slots a day, about 60 slots and 60 videos a month. Two platforms are enabled now (YouTube
and TikTok), so about 120 posts a month. With Facebook and Instagram it is about 240.
Budget: about US$100 a month for everything paid. The VM prices were checked 2026-11-11, EUR to USD
1.107. The Higgsfield and bridge figures come from the owner's account and from D-30 and D-29, not
from a page read today. Items marked **(unverified)** were not confirmed.

## Monthly total

| Line | Default config | Hard limit | Notes |
|---|---|---|---|
| VM | $10-17 | none | 4 vCPU / 8 GB class |
| Higgsfield subscription (video) | $65 | $65 | Ultra plan, 3,000 credits a month. A flat price: it does not change with use |
| Anthropic API | about $2 | $10 | `llm.monthlyCapUsd`. Estimate, see "Model calls" |
| Bridge (Zernio) | $0 | $12 | $0 with YouTube and TikTok connected. $12 with Facebook and Instagram added |
| Backups, alerts, monitoring | $0 | none | Free tiers |
| Remotion licence | $0 | none | Free up to 3 employees. $100 a month minimum above that |
| **Total now** | **$77-84** | | VM $10-17 + $65 + $2 + $0 |
| **Total with all four platforms** | **$89-96** | **$104** | Hard limit = VM $17 + $65 + API cap $10 + bridge $12 |

The hard limit of $104 is above the $100 budget by $4. The subscription is fixed, so the room left
for everything else is small. The API cap is the one line that can be lowered (`llm.monthlyCapUsd`).
The one thing that breaks the budget by more is the company growing past three employees, which
adds Remotion's $100.

Cheapest setup: a $10 VM, the bridge on its free accounts, and the subscription: about $77 with the
API estimate.

## VM

The pipeline is idle most of the day and renders for 15–25 minutes. It needs headless Chromium,
FFmpeg and a small CPU PyTorch model: 2 vCPU / 4 GB with swap is the floor, 4 vCPU / 8 GB is
comfortable. Disk 40 GB.

| Option | Spec | Price / month | Status 2026-11-11 |
|---|---|---|---|
| Oracle Cloud Always Free, Ampere A1 | 2 OCPU / 12 GB ARM ("1,500 OCPU hours and 9,000 GB hours per month") | $0 | Not recommended. "Idle Always Free compute instances may be reclaimed": 7-day window with CPU, network and memory all under 20%, and this pipeline idles most of the day |
| Hetzner CX33 | 4 vCPU / 8 GB x86 | €8.99 (~$10) | Listed "currently unavailable" |
| Hetzner CAX21 | 4 vCPU / 8 GB ARM | €10.99 (~$12) | Listed "currently unavailable" |
| Netcup VPS 500 G12.5 | 2 vCPU / 4 GB | €8.26 (~$9) | Orderable. Contract term applies |
| Hostinger KVM 2 | 2 vCPU / 8 GB | $8.79 promo, renews $14.99 | Orderable |
| Netcup VPS 1000 G12.5 | about 4 vCPU / 8 GB (spec to confirm) | €14.50 (~$16) | Orderable |
| Hetzner CPX32 | 4 vCPU / 8 GB | €30.49 (~$34) | Listed "currently unavailable" |
| AWS Lightsail | 2 vCPU / 8 GB | $44 | Orderable |
| DigitalOcean | 4 vCPU / 8 GB | $48 | Orderable |
| GCP e2-medium, AWS t4g.medium | 2 vCPU / 4 GB | ~$25 **(unverified)** | Not competitive. GCP's free e2-micro has 1 GB and cannot render |

Hetzner showed every cloud type as unavailable on the day of research. Availability and prices are
moving, so the deploy script is provider-agnostic (any Ubuntu 24.04 host, x86 or ARM64) and the
provider is chosen at deploy time in this order: Hetzner CX33 or CAX21 if orderable, then Netcup
VPS 1000, then Hostinger KVM 2. Oracle Always Free is left out: the workload is idle by design,
which is what Oracle's reclaim rule removes. It would be usable only if upgrading the account to
pay-as-you-go exempts the instance, and that was not confirmed. Remotion and the TTS model both run
on ARM64.

## Model calls

Prices per million tokens, from `src/llm/client.ts`: Sonnet 5.5 $2 in, $10 out, $0.10 cache read,
$2.50 cache write. Haiku 5.5 $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write. Opus 5.5
$4 in, $20 out. The models are set in `config/pipeline.config.ts` under `llm.models`: `script` is
Sonnet 5.5, `copy` and `qa` are Haiku 5.5, `escalation` is Opus 5.5 (off).

Every request goes through `callJson`, which checks the month's spend against `llm.monthlyCapUsd`
(**$10**) first and writes a row to `llm_calls`. At the cap, calls stop.

No live call has been made yet, so the token counts below are estimates, not readings. The system
text is the rules file plus the brief, about 2,000 to 2,700 tokens, and the estimates ignore prompt
caching, so they are on the high side. Re-read the real figures from `llm_calls` after the first
live day.

'ugc' mode (default), per slot:

| Purpose | Where | Model | Calls | Tokens in / out (estimate) | Cost per slot |
|---|---|---|---|---|---|
| `ugc` | `src/creative/ugc.ts` | Sonnet 5.5 | 1, up to 2 | 3,100 / 2,000 | $0.026 |
| `claims` | the judge of the caption and spoken line, `src/creative/claims.ts` | Haiku 5.5 | 1 per concept | 2,200 / 300 | $0.0004 |
| `copy` | `src/creative/copy.ts` | Haiku 5.5 | 1 | 2,500 / 1,000 | $0.0008 |
| `copycheck` | `src/creative/copy.ts` | Haiku 5.5 | 1 | 2,400 / 500 | $0.0005 |
| `vision` | frame check of a new clip, 6 frames plus a photo, `src/qa/vision.ts` | Haiku 5.5 | 1 per clip, up to 2 | 4,400 / 400 | $0.0006 |

A typical slot costs about $0.028, so 60 slots cost about $1.70. If every slot needed two concepts
and two clip checks, a slot would cost about $0.056 and the month about $3.30. Both are far under
the $10 cap. A slot that reuses a stored clip makes no `ugc` call.

'ad' mode (not the default): `hooks` and `script` (Sonnet 5.5) replace `ugc`, and the same `copy`,
`copycheck`, `claims` and `vision` calls apply. The earlier estimate for that mode was about $3.30 a
month.

Not built yet: the weekly review in `src/feedback` (Phase 8) has no `callJson` request yet. The Opus
escalation is off (`llm.escalationEnabled: false`) and has no `callJson` request.

The Batch API would halve these lines. It is not used: the saving is under $2 a month and it adds a
wait to the daily job.

## Video: Higgsfield credits

Clips are generated through Higgsfield's MCP server on the owner's subscription credits (D-30). The
Ultra plan was bought at $65 a month and grants 3,000 credits a month. Unused credits are removed at
renewal. One credit is $65 / 3,000, about $0.0217.

| Model, 15 s, 720p | Credits a clip | Dollars a clip | 60 clips a month |
|---|---|---|---|
| Wan 3.0 (default) | 26.25 | about $0.57 | 1,575 credits, about $34 |
| Seedance 2.0 fast | 37.5 | about $0.82 | 2,250 credits, about $49 |

The dollar figures are the credits times $0.0217. The $34 and $49 are the share of the $65 that the
clips use. The subscription costs $65 whether they are made or not.

Limits in `config/pipeline.config.ts`, `tiers`:

| Setting | Value | What it means |
|---|---|---|
| `capsUsd.t2` | 52 | About 2,400 credits a month, or 91 clips at 26.25 credits. Failed jobs count at their quoted price |
| `maxJobsPerSlot` | 2 | A slot starts at most two paid jobs, retries included. Worst case 60 x 2 x 26.25 = 3,150 credits, which the $52 cap stops at about 2,400 |
| `maxCredits` | 30 | A quote above 30 credits stops the job. Seedance 2.0 fast (37.5) needs `maxCredits` raised to 40, as the config comment says |
| `keepCredits` | 350 | A job that would leave fewer than 350 credits is not started. It is above Higgsfield's auto-refill threshold of 300, so the pipeline cannot trigger an automatic purchase |

The balance is read from Higgsfield before each job. Each job writes a ledger row in dollars.

There is no fal.ai tier. No provider exists for `t1`, and `mix.t1` is 0. The Higgsfield REST API is
not used: it bills a separate prepaid balance (D-30).

## Other lines

| Item | Choice | Cost |
|---|---|---|
| Bridge | Zernio: the first 2 connected accounts are free, $6 a month for each further account, unlimited posts. YouTube and TikTok are connected now, so $0. Facebook and Instagram added: $12 | $0 now, $12 with four platforms |
| Backups | Cloudflare R2: 10 GB free, free egress. The backup set is under 1 GB | $0 |
| Alerts | Discord webhook or Telegram bot | $0 |
| Dead-man's switch | healthchecks.io Hobbyist: 20 checks | $0 |
| Music | 'ad' mode only: beds synthesized by our code (D-16). 'ugc' mode adds no music | $0 |
| Render engine | Remotion, free for companies of up to 3 employees. Above that the automation licence has a $100/month minimum | $0 |
| Text-to-speech | 'ad' mode only: Kokoro-82M, Apache-2.0, on the VM's CPU. In 'ugc' mode the video model speaks | $0 |

The bridge prices are as reported from the owner's account on 2026-11-13. They were not re-read
today.

## Changing the budget

The video limits are in `config/pipeline.config.ts` under `tiers`: `capsUsd`, `maxJobsPerSlot`,
`t2.maxCredits` and `t2.keepCredits`. The model-call cap is `llm.monthlyCapUsd`. To change the
video model, replace the `t2` line with the commented alternative and check `maxCredits`.
