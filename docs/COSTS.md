# Costs

Volume: 2 slots a day × 4 platforms = 8 posts a day, about 60 slots and 240 posts a month.
Budget: about US$100 a month for everything paid. Prices checked 2026-11-11. EUR→USD 1.107.
Items marked **(unverified)** were not confirmed on an official page.

## Monthly total

| Line | Default config | Hard cap in config | Notes |
|---|---|---|---|
| VM | $10–17 | — | 4 vCPU / 8 GB class |
| Anthropic API | ~$3.30 | $10 | Sonnet 5.5 + Haiku 5.5 |
| Tier 1 clips (open-weight, hosted) | ~$5 | $15 | 40% of slots |
| Tier 2 clips (premium) | ~$4 | $25 | 10% of slots |
| Bridge for TikTok | $0–16 | — | Zernio's free accounts, or Upload-Post |
| Backups, alerts, monitoring, music | $0 | — | Free tiers, owned assets |
| Remotion licence | $0 | — | Free up to 3 employees. $100 a month minimum above that |
| **Total** | **~$22–45** | **≤ $91 worst case** | Worst case = every cap hit, $24 bridge, $17 VM |

Worst case stays under $100 because the caps are enforced in code: when a cap is reached the router
falls back to Tier 0 and sends one alert. No line can grow without a config change. Each provider
account is also prepaid and topped up by hand to no more than its cap, with auto-reload off, so the
ledger is not the only limit. The one thing that breaks the worst case is the company growing past
three employees, which adds Remotion's $100.

Cheapest setup: Tier 0 only, Zernio's free accounts, a $10 VM. About $13 a month.

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

## LLM tokens

Prices per million tokens: Sonnet 5.5 $2 in, $10 out, $0.10 cache read, $2.50 cache write.
Haiku 5.5 $0.10 in, $0.50 out. Output figures include adaptive-thinking tokens.

| Call | Model | Per month | Tokens per call (in / out) | Cost per month |
|---|---|---|---|---|
| Script for one slot | Sonnet 5.5 | 60, plus ~30% regenerations | 2,500 cached + 800 / 2,500 | $2.40 |
| Hook library refill | Sonnet 5.5 | 4 | 4,000 / 6,000 | $0.27 |
| Weekly strategy review | Sonnet 5.5 | 4–5 | 15,000 / 4,000 | $0.30 |
| Per-platform titles, captions, hashtags | Haiku 5.5 | 60 | 3,000 / 1,500 | $0.06 |
| Claim check | Haiku 5.5 | 80 | 3,000 / 500 | $0.04 |
| QA vision, 6 frames × 4 renders | Haiku 5.5 | 60 | 17,000 / 1,200 | $0.14 |
| Clip check against the source photo | Haiku 5.5 | ~36 | 3,500 / 300 | $0.02 |
| Product image tagging, error classification | Haiku 5.5 | few | small | < $0.05 |
| Opus 5.5 escalation (off by default) | Opus 5.5 | 0 | 20,000 / 4,000 | $0.16 each |
| **Total** | | | | **~$3.30** |

Prompt caching: the brand and product context is one stable prefix of about 2,500 tokens. The
day's calls run back to back, so every call after the first reads it from cache. The saving is
cents at this volume. It is wired in because the prefix is already structured that way.

The Batch API would halve this line. It is not used: the saving is under $2 a month and it adds an
asynchronous wait to the daily job.

## AI video clips

One 3–4 second image-to-video hook shot per slot, on the slots the router sends to Tier 1 or 2.

| Tier | Provider and model | Price | Per 4 s 720p clip |
|---|---|---|---|
| 1 | fal.ai LTX-2 image-to-video | "$0.0018 per megapixel of generated video data" | ~$0.16 |
| 1 | Higgsfield API, Wan 3.0 | "from 0.038 / s" | ~$0.15 **(a "from" price)** |
| 1 | fal.ai Wan 2.2 A14B | $0.08 per video-second at 720p | $0.32 |
| 2 | Higgsfield API, Seedance 2.5 | "from 0.118 / s" | ~$0.47 |
| 2 | Higgsfield API, Kling 4.0 | "from 0.126 / s" | ~$0.50 |
| 2 | Muapi, kling-v2.1-standard-i2v | $0.225 per generation | $0.23 (clip length not stated) |
| 2 | Veo 3.1 Fast | ~$0.10 / s **(unverified)** | ~$0.40 |
| 2 | Runway Gen-4 Turbo | ~6 credits / s | ~$0.46 |

Default mix: 50% Tier 0, 40% Tier 1, 10% Tier 2. With 20% of clips rejected by QA and regenerated:
24 × $0.16 × 1.2 ≈ $4.60 for Tier 1 and 6 × $0.50 × 1.2 ≈ $3.60 for Tier 2.

Exact per-clip prices are read from the provider at integration time (Phase 4) and stored in the
router's price table. The router checks the price and the remaining budget before every job.

### Tier 1 versus Tier 2

On price, Tier 1 costs about a third of Tier 2: $0.16 a clip against $0.50, so $9.60 against $30 a
month if all 60 slots used a clip. On quality the answer is not known yet. Phase 4 generates the
same hook shot on both tiers from the same photo and prompt, and the default mix is replaced by
what that shows. If Tier 1 holds up on product shots, Tier 2's share goes to zero.

### Self-run GPU versus hosted, honestly

| Approach | GPU cost | Fixed cost | Per clip at 60 a month |
|---|---|---|---|
| Hosted pay-per-clip (fal.ai LTX-2) | included | $0 | ~$0.16 |
| RunPod on-demand L40S ($0.79/h), started per daily batch | ~12 min per clip with cold start and model load | 60 GB weights volume at $0.07/GB = $4.20 | ~$0.23 |
| RunPod on-demand RTX 4090 ($0.34/h), same pattern | same, if the model fits 24 GB | $4.20 | ~$0.14 |
| Any GPU running 24/7 | $0.34/h × 730 h | — | $248 a month flat |

At this volume a self-run GPU saves between nothing and about $1 a month. It adds pod start and
stop logic, a weights volume, a ComfyUI or diffusers workflow to maintain, and a new way to fail at
night. Hosted wins. The comparison flips at several hundred clips a month, which is the point to
revisit it. A 24/7 GPU is never cheaper.

## Other lines

| Item | Choice | Cost |
|---|---|---|
| TikTok bridge | Zernio: first 2 connected accounts free, $6 per account after, unlimited posts. Upload-Post: $16/mo yearly or $24 monthly, unlimited uploads | $0–24 |
| Backups | Cloudflare R2: 10 GB free, free egress. The backup set is under 1 GB | $0 |
| Alerts | Discord webhook or Telegram bot | $0 |
| Dead-man's switch | healthchecks.io Hobbyist: 20 checks | $0 |
| Music | Tracks we own or CC0, stored in the repo | $0 |
| Render engine | Remotion, free for companies of up to 3 employees. Above that the automation licence has a $100/month minimum | $0 |
| Text-to-speech | Kokoro-82M, Apache-2.0, on the VM's CPU | $0 |

## Changing the budget

All caps live in `config/pipeline.config.ts` under `tiers.caps` and `llm.monthlyCapUsd`. The tier
mix is `tiers.mix`. Setting the Tier 1 and Tier 2 shares to zero makes the pipeline cost the VM plus
about $4.
