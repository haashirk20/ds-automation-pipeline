# Decisions

Each entry: what was chosen, what else was considered, why, and when to look again. Evidence and
sources are in `PLATFORMS.md` and `COSTS.md`. Dates are when the decision was made.

## Index

| ID | Component | Chosen |
|---|---|---|
| D-01 | Publishing layer | Superseded by D-29 |
| D-02 | TikTok public posting | Hosted bridge (now all platforms, D-29) |
| D-03 | Render engine | Remotion |
| D-04 | Language and repo shape | TypeScript on Node 24, one package |
| D-05 | Voice | Kokoro-82M through a Python CLI |
| D-06 | Caption timing | From the synthesizer, not speech recognition |
| D-07 | Scheduling and queue | One tick loop over SQLite |
| D-08 | State store | SQLite through `node:sqlite` |
| D-09 | Tier 1 clips | Hosted pay-per-clip open-weight model |
| D-10 | Tier 2 clips | Superseded by D-30 |
| D-11 | Model calls | Anthropic API, single structured calls |
| D-12 | Shopify ingest | Admin GraphQL, public JSON as fallback |
| D-13 | Hosting and provisioning | Any Ubuntu VM, one setup script |
| D-14 | Backups | restic to Cloudflare R2 |
| D-15 | Alerts and monitoring | One webhook plus a dead-man's switch |
| D-16 | Music | Beds synthesized by our own code |
| D-17 | Platform derivations | One master edit rendered four times |
| D-18 | Media delivery | Upload bytes directly; no public media host |
| D-19 | Secrets and tokens | `.env` plus a token table in the database |
| D-20 | AI disclosure | Computed per render; Tier 0 discloses by default |
| D-21 | Claims | Shopify fields only; tags are not claims |
| D-22 | Open-Higgsfield-AI | Not used |
| D-23 | Configuration format | A typed TypeScript file |
| D-24 | HTTP and SDKs | Built-in `fetch`; no platform SDKs |
| D-25 | FFmpeg | The binary Remotion ships |
| D-26 | Feedback ranking | Thompson sampling in code |
| D-27 | Fourth platform | Instagram Reels, replacing LinkedIn |
| D-28 | Creative format | AI-generated scene in a user-generated style, one caption |
| D-29 | Publishing layer | One hosted bridge for all four platforms |
| D-30 | Video generation | Higgsfield's MCP server, on the owner's subscription credits |
| D-31 | Retry rules for a slot | Outages wait without using an attempt; other errors after a paid clip retry once |
| D-32 | Admin GUI | A loopback web service over the shared database |
| D-33 | Posts on demand | Made now, held until the owner presses Post |
| D-34 | Owner music | Uploaded on the admin page, mixed under the clip's sound |
| D-35 | Video models | Added on the admin page, approved by one held test post; ledger records the live quote |
| D-36 | Overview diagram | ASCII, not Mermaid |

---

## D-01 Publishing layer: direct platform APIs (2026-11-11)

**Superseded by D-29 on 2026-11-13.** No direct publisher was built.

**Alternatives.** Self-hosted Postiz v2.25.3. A hosted bridge for all four platforms.

**Why not Postiz.** It was the leading candidate and was checked against its source code:

- It removes no approval step. Self-hosting needs our own developer app on every platform, so the
  TikTok audit applies exactly as it does to direct calls.
- Its YouTube settings have no `containsSyntheticMedia` field, so it cannot set YouTube's AI disclosure.
- Its Facebook provider posts to `/{page}/videos` by URL. It does not use the Reels endpoint and
  needs the media on a public HTTPS URL.
- Its public API has no idempotency key, no single-post status call and no analytics. Phase 8 would
  need direct API tokens anyway.
- Its compose file runs nine containers: the app, two Postgres, Redis, Temporal, Elasticsearch and
  Temporal tooling. The docs recommend 4 vCPU / 8 GB for that alone.
- Open issues in the last weeks on all four providers we need: TikTok scope errors on new apps
  (#2383), failed TikTok uploads reported as pending (#2369), YouTube token refresh (#1595, #2233),
  Facebook tokens flagged at 59 days (#2299).

Postiz is AGPL-3.0. That would have been fine: we would run it unmodified in its own container and
talk to it over HTTP.

**Why direct.** Four small modules with full control of flags, idempotency and metrics. No inbound
port, no public media URL. The owner's existing project `../social_media_posting_mcp/server.py`
already implements the YouTube, TikTok and Facebook upload and auth flows in 336 lines and is the
reference for the port.

**Revisit when.** A fifth or sixth platform is wanted and Postiz has closed the gaps above.

## D-02 TikTok public posting: hosted bridge (2026-11-11)

**Alternatives.** Our own TikTok app with an audit. Inbox drafts finished by hand. Private posts only.

**Why.** TikTok's guidelines list "A utility tool to help upload contents to the account(s) you or
your team manages" as not acceptable for the audit, and unaudited apps can only post `SELF_ONLY`.
No open-source or self-hosted route can change that, which is the condition for using a paid
service. A bridge is a multi-tenant product, which is the use case TikTok does audit.

**Cost.** $0–24 a month. Zernio: first two connected accounts free, then $6 per account, unlimited
posts. Upload-Post: $16 a month billed yearly, unlimited uploads. Capped vendors are rejected.

**Condition.** The bridge must accept an idempotency key or a reference we can search for.
Otherwise a lost response on the create call stops and waits for a person, because retrying could
post twice.

**Status.** The owner chose the bridge route on 2026-11-12. Vendor claims are verified with one
real post before the adapter is committed. The owner creates the account. The TikTok publisher takes a `mode` so the bridge can be swapped, and
`direct` mode (own app, private) stays for testing.

**Revisit when.** TikTok changes its audit rules, or the bridge changes price or terms.

## D-03 Render engine: Remotion 4 (2026-11-11)

**Alternatives.** HyperFrames (HeyGen, Apache-2.0, HTML to video). FFmpeg filtergraphs or MoviePy.

**Why.** The ads are the product, and kinetic type, springs and layout are what make them look
made. Remotion is the mature tool for that and renders frame-exact on CPU, on x86 and ARM64.
HyperFrames is fully permissive but its maturity could not be established. FFmpeg alone is light
and boring, and every new template would be a filtergraph that is hard to read and hard to vary.

**Licence.** Remotion is source-available, not open source. It is free for "a for-profit
organization with up to 3 employees". The owner confirmed on 2026-11-12 that the company (Giftwell, formerly Merry Marts) has three
employees, which is inside the free tier. A fourth employee triggers the paid licence.
Above that, the automation licence has a $100 a month minimum, and HyperFrames becomes the
alternative. `@remotion/transitions` shows `UNLICENSED` on npm and is not used.

## D-04 Language and repo shape: TypeScript on Node 24, one package (2026-11-11)

**Alternatives.** Python throughout. A pnpm workspace with `apps/` and `packages/`.

**Why.** Remotion needs Node, so Node is in the image regardless. Using it for everything keeps one
runtime for the long-running process. Node 24 runs TypeScript without a build step and has a test
runner, `fetch` and SQLite built in, which keeps the dependency list short. One package, because
there is one deployable and one owner. See `ARCHITECTURE.md`, "Repository layout".

## D-05 Voice: Kokoro-82M through a Python CLI (2026-11-11)

**Alternatives.** `kokoro-js` in Node. Piper. A paid voice API.

**Why.** Kokoro-82M is Apache-2.0, runs on CPU, and has 54 voices. The Python package returns
per-word timestamps for English, which gives exact caption timing for free. `kokoro-js` returns
audio only. Piper's code is GPL-3.0 and its voices carry assorted licences. A paid voice sounds
better and costs money, and is one config change away if Kokoro is not good enough.

**Cost of the choice.** A second language in the image: one script of about 50 lines, run as a
one-shot command. PyTorch CPU adds roughly 1.5 GB to the image.

## D-06 Caption timing: from the synthesizer, not speech recognition (2026-11-11)

**Alternatives.** faster-whisper. whisper.cpp through `@remotion/install-whisper-cpp`.

**Why.** The brief suggested Whisper. We already hold the exact script, so recognizing our own
audio would add a model that can mishear "$49.99" or "shawl" and then need alignment back to the
script. Synthesizer timestamps are exact and use the true text. whisper.cpp also needs a C++
toolchain to build.

**Revisit when.** Audio comes from somewhere without timestamps, such as a paid voice or a clip
with speech. Then faster-whisper (MIT) is added for alignment.

## D-07 Scheduling and queue: one tick loop over SQLite (2026-11-11)

**Alternatives.** systemd timers or cron starting one-shot containers. BullMQ with Redis, or Temporal.

**Why.** Eight posts a day is not a queueing problem. A loop that asks the database "what is due?"
once a minute is restart-safe by construction and makes `docker compose up` the whole deployment,
the same locally and on the VM. Timers would work and would put part of the system outside the
repo's compose file. A broker is another service to keep alive at 3am for no benefit at this volume.

## D-08 State store: SQLite through `node:sqlite` (2026-11-11)

**Alternatives.** Postgres. `better-sqlite3`. JSON files.

**Why.** One writer, a few hundred rows a month, one file to back up. `node:sqlite` is built into
Node 24 and was tested on v24.22.2. It is still marked experimental, so the Node version is pinned,
and `better-sqlite3` has a near-identical API if it has to be swapped.

## D-09 Tier 1 clips: hosted pay-per-clip open-weight model (2026-11-11)

**Alternatives.** Our own on-demand GPU pod (RunPod, Modal) started for each batch. A 24/7 GPU.

**Why.** The brief asked for an honest comparison. At 24–60 clips a month, hosted LTX-2 costs about
$0.16 a clip and a self-run pod costs $0.14–0.23 once cold start and the weights volume are counted.
The saving is at most about $1 a month, for a new subsystem that can fail overnight. A hosted
endpoint is an on-demand GPU that someone else starts and stops. See `COSTS.md`.

**Cost.** Capped at $15 a month. Provider and model are entries in the router's table. First
choice is fal.ai LTX-2, confirmed with a real job in Phase 4. The 50/40/10 tier mix is a
placeholder until Phase 4 compares Tier 1 and Tier 2 on the same shot.

**Revisit when.** Volume passes a few hundred clips a month.

## D-10 Tier 2 clips: Higgsfield REST API under a hard cap (2026-11-11)

**Superseded by D-30 on 2026-11-13.** The REST API bills a separate prepaid balance, which is empty.

**Alternatives.** Muapi. Vendor APIs directly (Kling, Veo, Runway).

**Why.** The owner already uses Higgsfield, and it has a REST API with key authentication and a
prepaid dollar balance, which the pipeline can call without an interactive session. The Higgsfield
MCP server stays a build-time convenience. Muapi is the alternative behind the same interface.

**Cost.** Capped at $25 a month. About $0.50 a clip.

**Open point for Phase 4.** The owner's Higgsfield subscription (plan "ultra", 523 credits on
2026-11-12) is reachable through the MCP server, while the REST API bills a separate prepaid
balance. Phase 4 checks whether the pipeline can call the MCP server as a plain client, with no
model in the loop, so that Tier 2 spends credits already paid for. If not, it uses the REST API.

## D-11 Model calls: Anthropic API, single structured calls (2026-11-11)

**Alternatives.** The Agent SDK. The Batch API. A local model.

**Why.** Each creative step is one request with one JSON answer. An agent loop would add turns,
cost and variance to a pipeline that is meant to be deterministic around its model calls. The
Batch API would save under $2 a month. A local model good enough for ad copy needs a GPU.

**Cost.** About $3.30 a month, capped at $10. Sonnet 5.5 for hooks, scripts and the weekly review.
Haiku 5.5 for copy, claim checks, vision QA, tagging and labelling unrecognized errors. Opus 5.5
for escalation, off by default.

**When the cap is hit or the API is down.** Posting continues from approved scripts whose hooks are
outside their 14-day window. A spend cap that stopped posting would be a post cap by another name.

## D-12 Shopify ingest: Admin GraphQL, public JSON as fallback (2026-11-11)

**Alternatives.** The Shopify MCP at runtime. The Storefront API.

**Why.** The public `/products.json` works today without credentials and returned the full
product, and it also returned HTTP 429 twice in one session. The Admin API is the stable route and
is the only way to read review metafields. New admin-created custom apps can no longer be made, so
credentials come from a Dev Dashboard app using the client-credentials grant, whose tokens last
24 hours and are fetched on demand. Latest stable API version is 2026-10. Until credentials exist
the pipeline uses the public endpoint and reuses its last good brief on failure.

## D-13 Hosting and provisioning: any Ubuntu VM, one setup script (2026-11-11)

**Alternatives.** Terraform against one provider. Serverless rendering (Remotion Lambda, Cloud Run jobs).

**Why.** Hetzner, the expected choice, listed every cloud type as unavailable on the day of
research and its prices had moved. Tying provisioning to one provider's Terraform resources would
have been the wrong bet. Manual setup steps for Ubuntu 24.04 (STARTUP.md section 4) work on any host. A setup script was planned and not written.
Serverless would split state and rendering across services to save a VM that costs $10.

**Shortlist.** Hetzner CX33 or CAX21 (about $10–12), Netcup VPS 1000 (about $16), Hostinger KVM 2
($9–15). Oracle Always Free is left out: its reclaim rule targets idle instances and this workload
is idle most of the day. GCP and AWS small instances cost $25–48 for the same shape. The owner
creates the account.

## D-14 Backups: restic to Cloudflare R2 (2026-11-11)

**Alternatives.** Litestream. Provider snapshots. Running restic inside the pipeline container.
A host cron job.

**Why.** The state worth keeping is one database file under 1 GB that includes the tokens. A
nightly encrypted copy with retention is enough: losing a day loses nothing that cannot be
regenerated. Litestream is a second always-on process. Snapshots are provider-specific and unencrypted.

**Details.** The pipeline writes a `VACUUM INTO` snapshot to `data/backup/pipeline.db` each night
and then `data/backup/ready` with its time. restic backs up that snapshot and `data/clips` (paid
assets and the `ugc` reuse library), never the live file, which could be copied mid-write. The restic password and R2 keys are also kept off the VM by the owner. A restore brings
back tokens as they were, so platforms whose refresh tokens rotate are authorized again afterwards.

**Second service (2026-11-14).** restic runs as a second compose service, `backup`, on the official
image `restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`
(BSD-2-Clause). It runs as uid 1000 with no capabilities, a read-only root, the data volume mounted
read-only and its own secrets file `.env.backup`. `infra/backup.sh` checks every 10 minutes whether
`ready` changed, backs up, applies retention (7 daily, 4 weekly) and writes `last-ok` to the
`backup-status` volume, which the pipeline reads (read-only) to report a stale backup in the daily
summary. Once a week it runs `restic check --read-data-subset=5%`. Why not inside the pipeline
container: the R2 keys and the restic binary would sit in the process that handles model output
and web data. Why not host cron: it would put a second deployment step and unpinned host tools
outside `docker compose up -d`.

**Limits and accepted risks (2026-11-14).** The container has 768 MB of memory, 64 processes, a 128 MB
`/tmp` and a 256 MB restic cache, and uploads with `s3.connections=2`. The first upload to R2 with a
`data/clips` folder over 100 MB is still unverified: it is a Phase 7 check. Accepted risk: the R2
token needs delete rights so `forget --prune` can work, so anyone with root on the VM or the key can
delete the backups. The mitigation, not done now, is an R2 bucket lock with a separate prune key.
`infra/backup.sh` trusts nothing in `ready`: it must be a regular file, not a symlink, at most 40
bytes of `[0-9TZ:.-]`, or it is ignored and never logged. A failed `restic check` writes
`check-failed` to the status volume, which the summary and `doctor` report. After a failed cycle the
loop doubles its sleep up to 6 hours.

**After a restore.** The snapshot can be a day old, so a post made after it would be posted again.
`node src/cli.ts after-restore` marks every publication that is `pending` or `uploading` and due as
`needs_attention` ("restored from backup: check the platform before posting again"). The owner
checks the platform and resolves each one. This keeps the never-double-post rule across a restore.

## D-15 Alerts and monitoring: one webhook plus a dead-man's switch (2026-11-11)

**Alternatives.** Email over SMTP. A self-hosted monitor (Uptime Kuma, Grafana).

**Why.** A Discord or Telegram webhook is one HTTP call with no account to run. It cannot report
that the VM itself is dead, so the loop pings healthchecks.io (free) and that service emails when
the pings stop. A second check there is pinged only when the daily summary has been delivered, so
a dead webhook is noticed too. A day's summary that was never delivered is not sent later. The
daily dead-man ping, which is not sent that day, is what tells the owner. A self-hosted monitor on
the same VM dies with it.

## D-16 Music: beds synthesized by our own code (2026-11-12)

**Alternatives.** A library of CC0 tracks. A stock subscription. An AI music model (ACE-Step 1.5,
MIT). Platform music libraries.

**Why.** An unattended poster cannot answer a copyright claim. Free libraries allow commercial use,
and some of their tracks are registered with Content ID by their authors. TikTok limits business
content to its commercial library or audio the poster has rights to, and no platform library is
reachable through an API. A CC0 library was the first choice and could not be assembled (see
"Attempts abandoned"). So `tools/music/bed.py` synthesizes a short instrumental bed from a seed:
electric piano, pad, bass and light percussion in numpy. We own the output outright, nothing can
claim it, every slot gets a different bed, and it is not AI-generated, so it does not trigger the
AI-music disclosure. It costs nothing and adds no asset to store.

**Cost of the choice.** It is a simple bed, not a produced track. It plays quietly under the voice.
`music.enabled: false` turns music off. (An earlier draft said the owner could drop licensed tracks
into `assets/music/` with a manifest entry. That was never built. Owner tracks are D-34, `ugc` mode
only, uploaded on the admin page.)

**Revisit when.** The owner supplies tracks, or the bed is judged too plain. ACE-Step run once on a
rented GPU is the next step up, and its output would count as AI music for disclosure.

## D-17 Platform derivations: one master edit rendered four times (2026-11-11)

**Alternatives.** One file for all platforms. Burn overlays onto a base video with FFmpeg.

**Why.** Script, voice, music and clip are made once per slot, which is where the cost is. Rendering
the same edit four times costs CPU minutes that are already paid for, and lets each platform have
its own safe zones and call-to-action wording. A single shared file would have to fit the tightest
safe zone everywhere. Overlaying with FFmpeg would mean two layout systems.

## D-18 Media delivery: upload bytes directly (2026-11-11)

**Alternatives.** A public bucket with pull-by-URL. Serving the files from the VM over HTTPS.

**Why.** All four APIs accept a direct upload. Pull-by-URL would need a public HTTPS host, and on
TikTok a verified domain. Serving from the VM would open its first inbound port. Nothing public
means nothing to secure.

## D-19 Secrets and tokens: `.env` plus a token table (2026-11-11)

**Alternatives.** Docker secrets. SOPS or age-encrypted files. A cloud secret manager.

**Why.** Static secrets belong in `.env`, as the brief requires. Tokens that rotate (TikTok,
direct mode) must be written back atomically by the process, and `.env` is read-only configuration, so
they live in the database on the data volume and are covered by the encrypted backup. One VM and
one operator do not justify a secret manager.

## D-20 AI disclosure: computed per render (2026-11-11)

**Alternatives.** Never flag Tier 0. Let the owner set flags by hand.

**Why.** Each render's manifest says whether visuals, voice or music are synthetic. Tier 1 and 2
always set the flags. Tier 0 (real photos, synthetic voice) is a grey area on every platform, and
the default is to disclose: the published policies penalize missing labels, not present ones.
`disclosure.tier0` can turn it off. Instagram's API has no flag, so a render with AI-generated
footage adds one line to the caption. Embedding C2PA metadata was considered and dropped: it needs a
signing certificate, and a self-signed one is not trusted. See the matrix in `PLATFORMS.md`.

## D-21 Claims: Shopify fields only (2026-11-11)

**Alternatives.** Let the model use general product knowledge. Use tags as claims.

**Why.** The brief forbids invented claims. Facts come from title, description, variants, options
and price, each with its source field. Tags such as "bestseller" steer the angle and are never
stated. No discount language without a compare-at price. No review language without review data.
"Power bank not included" is treated as a mandatory disclosure in every caption and end card.
Checks are code first, then a Haiku pass.

**Text printed on photos.** Six of the ten photos are supplier infographics that state features the
description does not: three heat levels, zip front, plush lining, machine washable, a 10,000 mAh
power bank. The photos are Shopify data, and the supplier's printed claims are not checked facts.
They are not used as claims, and there is no switch for it: nothing in the pipeline reads claims
from photos. The fix is to add the true facts to the Shopify description.

## D-22 Open-Higgsfield-AI: not used (2026-11-11)

Confirmed as described in the brief: a fork of `Anil-matcha/Open-Generative-AI` (MIT), a desktop
and web UI for Muapi's hosted API with no CLI and no local inference in the web app. It offers the
pipeline nothing that Muapi's API does not, and Muapi is already the documented alternative in D-10.

## D-23 Configuration format: a typed TypeScript file (2026-11-11)

**Alternatives.** YAML. Environment variables only.

**Why.** Node runs it directly, so it needs no parser dependency, allows comments, and is
type-checked. It is validated again at startup. Secrets stay in `.env`.

**Amended 2026-11-14 (D-32).** The file is now the defaults and ceilings. Sparse overrides saved from
the admin page live in the database and are merged and validated with the same schema on every
tick. The file format is unchanged.

## D-24 HTTP and SDKs: built-in `fetch` (2026-11-11)

**Alternatives.** `googleapis` and other platform SDKs. A general HTTP client such as `got` or `axios`.

**Why.** Each platform needs three to five HTTP calls. The SDKs are large, and two of the four
platforms have no maintained official Node SDK for these endpoints. A general client adds retries
and timeouts that `fetch` with `AbortSignal.timeout` and our own retry table already cover. The
Anthropic SDK is the one exception and is used for all model calls.

## D-25 FFmpeg: the binary Remotion ships (2026-11-11)

**Alternatives.** A full FFmpeg from the distribution's packages. The `ffmpeg-static` npm package.

**Why.** Remotion installs FFmpeg 7.1 and `ffprobe` with it, so there is nothing to add. That build
is minimal: it has `loudnorm`, `silencedetect`, `scale`, `amix` and `volume`, and the H.264, AAC,
PNG and raw-video encoders, and it lacks `blackdetect`, `freezedetect` and `ebur128`. The two
missing video checks take about 25 lines of code over frames decoded to 32×57 greyscale, and
loudness is measured with `loudnorm`. That is less than carrying a second FFmpeg.

**Revisit when.** A filter is needed that cannot be replaced this cheaply.

## D-26 Feedback ranking: Thompson sampling in code (2026-11-11)

**Alternatives.** Let the weekly Sonnet review set the weights. Epsilon-greedy.

**Why.** Weights set by a model would make the sampler non-deterministic and hard to test, and
choosing what to post next is arithmetic, not judgment. Thompson sampling needs two counters per
option and balances winners against untried options without a tuning knob, which epsilon-greedy
needs. Sonnet's weekly review writes commentary and suggests angles for new hooks, which is
creative work. The metric is defined in `ARCHITECTURE.md`, "Feedback loop".

## D-27 Fourth platform: Instagram Reels, replacing LinkedIn (2026-11-12)

**Alternatives.** LinkedIn Company Page. LinkedIn personal profile.

**Why.** The owner's decision. It also removes the hardest approval in the plan: LinkedIn Page
posting needs a reviewed app for a registered legal entity, and a personal profile needs a manual
login every 60 days. Instagram uses the Meta app and the non-expiring Page token that Facebook
already needs, so it adds no approval and no second credential, and its audience fits a consumer
gift better.

**Cost of the choice.** Instagram has no private or unlisted post, so its test stops one step
short of publishing. Its API has no AI-disclosure field. See `PLATFORMS.md`.

---

## D-28 Creative format: an AI-generated scene in a user-generated style (2026-11-13)

**Chosen.** `creative.mode: 'ugc'` is the default. Each slot is one 15-second AI-generated scene
that looks like something a person filmed: one woman, one place, a small story in three to five
shots, at most one spoken line in the first shot, room sound, and one caption that stays at the top
of the frame. There is no end card, price, logo overlay or call to action in the picture. The
photo templates remain as `creative.mode: 'ad'`.

**Alternatives.** Keeping the three photo templates. Restyling them as a photo slideshow with a
caption. Both cost nothing to run, and neither looks like the owner's references.

**Why.** The owner asked for it on 2026-11-13 and supplied two reference videos: "UGC style videos
with minimal text except for a caption on screen with a female voice starting off the video with a
hook or speaking minimally", "not structured like ads but more like satisfying user generated
content". Both references are 15.07 s, 1080x1920, fully generated, with one static two-line
caption and one spoken line ("It's freezing in here").

**What follows from it.**
- The voice comes from the video model, in the scene. D-05 (Kokoro), D-06 (caption timing) and D-16
  (music beds) apply to `ad` mode only. Reference 1 carries a commercial song; the pipeline adds no
  music of its own. Since 2026-11-14 the owner may upload tracks they hold the rights to, and `ugc`
  mode mixes them under the clip (D-34).
- One render serves every platform (D-17 applies to `ad` mode only): the caption sits below the
  largest top safe zone, and nothing else is drawn.
- Every video is AI-generated, so the AI disclosure flag is always on (D-20).
- D-21 still holds for words: the caption and the spoken line pass the same deterministic checks
  and the claim judge. They may state an opinion, never a fact the brief lacks. The woman is a
  character in a scene. She is never presented as a customer giving a review.
- What the product looks like and visibly does comes from `config/product-notes.json`, written by
  the owner, because Shopify's data does not describe it. The current note says the power button
  glows red when the heat is on, which is what the owner's own reference videos show.
- A model looks at eight frames of every new clip (720x1280) before it can be posted
  (`src/qa/vision.ts`, `prompts/vision.md`). It compares them with the product's reference photos
  and the owner's product note. It lists every piece of writing it sees by kind. An overlay fails.
  Prominent writing fails unless it is the shop's name. Background writing never fails. The clip
  also fails when the product is not visible, when it does not match the note and the references,
  when the shop name is misspelled, and on a generation fault. A feature or behaviour that
  contradicts the note is a mismatch, for example a button that glows the wrong colour. The
  verdict is computed in code from the model's answers.
- When no new clip can be made (cap reached, credits low, sign-in expired, two rejected clips),
  the slot reuses a stored clip that has not been posted for `ugc.reuseAfterDays` days. The stored
  concept is checked again against the current brief first, and the reuse sends a `degraded`
  alert. With none available the slot fails and alerts. It does not fall back to a photo ad.

**Frame check calibration (2026-11-14).** On Haiku 5.5 at low effort, five runs each of a labelled
set of five clips gave the expected verdict 25 of 25 times. Two clips made by the owner and one
Wan 3.0 clip passed. A Kling clip with a blue button and a Seedance Mini clip with a misspelled box
lid failed. One call costs about $0.0017. The frame check is not proof for other clips: the set is
small.

**Not checked.** The spoken line is not transcribed at run time. In four test clips the line came
out word for word, so this is left out until a clip gets it wrong.

**Revisit when.** A posted clip turns out to have a wrong spoken line or a fault the frame check
missed, or the owner wants a mix of formats.

## D-29 Publishing layer: one hosted bridge for all four platforms (2026-11-13)

**Chosen.** Every platform publishes through Zernio (`src/publish/bridge.ts`). This supersedes D-01
and widens D-02.

**Alternatives.** Direct platform APIs for YouTube, Facebook and Instagram, with the bridge for
TikTok only (the earlier plan). Self-hosted Postiz.

**Why.** The owner connected YouTube and TikTok at the bridge and supplied its key, and no Meta or
Google app credentials. One publisher replaces four, with no OAuth apps, token storage or app
review on our side. The bridge takes an `Idempotency-Key` that holds for 24 hours, returns a post
id that can be read back, and rejects identical content sent to the same account within a day,
which is what the never-double-post rule needs.

**Cost.** The first two connected accounts are free and each further account is $6 a month, so
four accounts cost $12 a month. Posts are unlimited.

**Risk.** One outside service now carries every post. If it is down, publications retry for
`publish.maxLatenessMinutes` and are then skipped with an alert, or marked `needs_attention` when a post request may already have been sent. A post the bridge reports as
failed is treated as final and not retried, on purpose: a missed post is acceptable and a double
post is not. A permanent error after a handle is stored ends `needs_attention`, not `skipped`,
because a post request may have been sent. The account list request refuses redirects, like every
other request that carries the key.

**Status.** Live private test posts on YouTube and a TikTok inbox draft were made on 2026-11-13.
Running the test again resumed both from the stored handle and created no second post. Facebook and
Instagram are disabled in the config until the owner connects them at the bridge.

**Facts read from the bridge's documentation on 2026-11-14.**
- A retry with the same idempotency key within 24 hours returns the original post, whatever the
  body.
- `idempotency_conflict` (HTTP 409 with `Retry-After`) means the first request with that key is
  still being processed.
- A post with the same content to the same account within 24 hours is refused with 409 and
  `details.existingPostId`.
- The presign `uploadUrl` is valid for one hour. The `publicUrl` (media.zernio.com) is valid for
  seven days.
- The bridge offers post analytics: `GET /v1/analytics`, by its own post id or the platform's id.
  YouTube and TikTok give views, likes, comments and shares. It is included in the per-account
  price. This is the data source for Phase 8.

**Rules the code follows.**
- A publication with a stored handle is never marked `skipped`. When its retries run out, or it is
  too late or its slot failed, it becomes `needs_attention`, because a post request may have been
  sent.
- Polling a post stops after 90 seconds (nine polls, ten seconds apart). The next attempt reads the
  stored post id and carries on from there.
- A post the bridge cannot be read back for, while we hold its id, is `needs_attention`, never a
  plain failure. A cancelled post is final.
- Requests to the bridge refuse redirects.

**Revisit when.** The bridge changes price or terms, loses a platform, or reports failures that
turn out to have posted.

## D-30 Video generation: Higgsfield's MCP server, on the owner's subscription (2026-11-13)

**Chosen.** Tier 2 calls the Higgsfield MCP server (`https://mcp.higgsfield.ai/mcp`) as a plain
HTTP client: JSON-RPC over `fetch`, no model in the loop, no SDK (`src/router/mcp.ts`,
`src/router/higgsfield.ts`). The owner signs in once with `node src/cli.ts auth higgsfield`
(authorization code with PKCE; the client registers itself). Tokens live in the database.

**Alternatives.** The Higgsfield REST API (D-10). fal.ai or another pay-per-clip host.

**Why.** The owner asked for it on 2026-11-13: "so it uses my monthly credits". The REST API draws
on a separate prepaid balance; a real submit there returned `403 not_enough_credits` while the
subscription held 1,418 credits. The MCP server is the only programmatic route to subscription
credits. Higgsfield's terms allow it: section 11.12, "If you use Developer Access to connect the
Service to any third-party artificial intelligence agent, automation platform, or orchestration
tool (including via MCP), you are solely responsible for: (i) all actions taken by such agent or
tool using your credentials" (https://higgsfield.ai/terms, last updated 2026-10-23).

**Limits.** One fetch polls for at most 25 minutes. A job that has given no file 2 hours after it was
created is marked `failed` and the slot uses a stored clip (D-31). The produce timeout is 90
minutes. The vision check also fails any writing within edit distance 1 or 2 of the shop's name, of
any kind, because the model may read a near-miss as the name.

**Cost.** The Ultra plan grants 3,000 credits a month, and unused credits are removed at renewal.
Quotes for one 15-second 9:16 clip with sound, read from the server on 2026-11-13:

| Model | Setting | Credits |
|---|---|---|
| Seedance 2.5 | 1080p / 720p / 480p | 240 / 105 / 45 |
| Seedance 2.5 Flash | 720p | 75 |
| Seedance 2.0 | 720p std / fast | 67.5 / 37.5 |
| Kling 3.0 | std | 30 |
| Wan 3.0 | 720p | 26.25 |
| Kling 3.0 Omni (image reference) | pro / std | 30 / 18.75 |
| Seedance 2.0 Mini | 720p | 15 |

The owner's references were Seedance 2.5 at 240 credits each, which is 12 videos a month. The same
scene was generated once on four models (97.5 credits). Wan 3.0 followed the shot list most
closely and kept the logo right. Seedance 2.0 fast looked most like phone footage. Kling Omni came
out glossy and lit the button blue. Seedance 2.0 Mini misspelled the logo and duplicated the
product. All four spoke the line correctly. **Default: Wan 3.0 at 720p**, 60 clips for about
1,575 credits. Seedance 2.0 fast is the alternative at about 2,250.
Four more presets and the admin page's custom models are in D-35.

**Budget rules.** The ledger stays in dollars: `usdPerClip` is the quoted credits times what a
credit costs on the plan ($65 for 3,000). Since D-35 the row records the live quote times that rate. Before each job the provider reads the live balance and
the server's quote. A quote above `maxCredits` stops the job, and so does a job that would leave
fewer than `keepCredits`. `keepCredits` is set above Higgsfield's auto-refill threshold (300), so
the pipeline cannot cause an automatic purchase if the owner turns auto-refill on.
- Before the paid call, the provider asks for the quote again on the exact request, reference
  images included, and applies `maxCredits` and `keepCredits` to that quote.
- A quote answer that holds a started job, or no positive number, stops clips (fail closed).
- A fetch that fails for any reason other than the job having ended keeps the ledger row
  `submitted`. The slot waits and resumes the same job. Only a job the server reports as ended is
  marked `failed`.
- The architect's finding 8, that the ledger recorded the configured `usdPerClip` and not the live
  quote, is closed by D-35.

**Risks.**
- `generate_video` has no idempotency key. A call whose outcome is unknown is never repeated, so a
  crash at that moment can cost one clip.
- The server is built for assistants. Its tool names and result shapes can change without notice.
  The provider fails closed and alerts.
- If the refresh token is refused, the owner has to sign in again. Slots reuse stored clips until
  then.

**Status.** Built and tested against fakes. Result shapes were observed through another client of
the same server. No signed-in video job from this client has run yet. The token was refreshed on
2026-11-14.

**Revisit when.** Higgsfield changes the plan's credits, the quotes, or the MCP tools, or the
subscription's credits become reachable through the REST API.

## D-31 Retry rules for a slot (2026-11-14)

**Chosen.** `produceSlot` (`src/render/produce.ts`) and `tick` (`src/scheduler/loop.ts`) treat
errors in three ways.
- **A passing outage.** The model rate limit or a 5xx (`RetryableLlmError`), and a paid clip that
  cannot be fetched yet (`ClipPendingError`), put the slot back to `planned` and give back the
  attempt. A job is waited for at most 2 hours after it was created (`PENDING_JOB_MAX_MS`); then its
  ledger row is `failed` and the slot uses a stored clip. A fetch polls for at most 25 minutes. A
  concept-writer outage gives the attempt back only once per slot; a repeat uses it (the slot fails
  when the attempts are used). One `degraded` alert is sent. An outage of the concept writer with no stored clip to
  reuse, and of the frame check, take this path. The same holds for `NoBriefError`, which sends an
  `ingest_failed` alert instead.
- **Any other error after a clip was paid for** (a ledger row `submitted` or `succeeded`). The slot
  goes back to `planned` while `attempt < render.maxAttempts` (2), and uses the attempt. The retry
  finds the paid clip in the ledger and the concept in `master_json`, so it pays nothing twice.
- **Any other error with no paid clip,** or once the attempts are used: the slot is `failed` and
  `produce_failed` alerts.

The tick waits 10 minutes, measured from the end of the attempt, before it starts a planned slot that has an error. The "too late" rule
ends the wait: a planned slot with no pending publication scheduled within
`publish.maxLatenessMinutes` fails as "too late". A `producing` slot not touched for
`render.produceTimeoutMinutes` (90, at least `maxJobsPerSlot * 40 + 10` in `ugc` mode) goes back to `planned` while attempts remain.

**Alternatives.** Failing the slot on any error: it loses the paid clip. Giving the attempt back
for every error: a deterministic error would retry every 10 minutes for hours and use up the model
budget.

**Revisit when.** A deterministic error is seen to burn the one retry, or an outage lasts past the
lateness window often enough that slots are lost.

## Paid services

| Service | Why open source cannot do it | Monthly cost | Cap |
|---|---|---|---|
| Higgsfield subscription (video credits, D-30) | Video generation needs closed models | $65 (Ultra plan, 3,000 credits) | Flat price. `tiers.capsUsd.t2` of $52 limits use to about 2,400 credits |
| Anthropic API | Ad copy quality and vision QA | About $2 | `llm.monthlyCapUsd`, $10 |
| Bridge, Zernio (D-29) | TikTok will not audit an internal tool (D-02), and one publisher replaces four | $0 with YouTube and TikTok, $12 with Facebook and Instagram added | None. Posts are unlimited |
| VM | The pipeline has to run somewhere | $10-17 | None |
| Remotion | Free at this company size. Not open source (D-03) | $0, or $100 above 3 employees | None |

Not used: fal.ai (no provider exists for tier 1), the Higgsfield REST API (separate prepaid balance,
D-30) and direct platform apps (D-29).

## D-32 Admin GUI: a loopback web service over the shared database (2026-11-14)

**Chosen.** A second compose service, `admin`: same image, published on `127.0.0.1` only, reached by
SSH tunnel or Tailscale. Server-rendered HTML on `node:http`, no client JavaScript, no new
dependency. The file is the defaults and ceilings. The database holds sparse, versioned overrides and
prompt versions. The pipeline merges and validates them with the same zod schema and guard rules on
every tick and in every producer, and falls back to the file with a `config_invalid` alert. One
admin: a scrypt hash in the database set by `admin password`, a session cookie, Host and Origin
checks, a CSRF token, and a CSP with no script source.

**Master prompt: both.** `video` is the style text that frames every Higgsfield request (the first
paragraph of `buildClipPrompt`, moved to `prompts/video.md`; the sentence limiting speech to the one
line stays in code and comes last). `house` is a house style text (`prompts/house.md`) prepended to
the writer prompts only (`ugc`, `copy`, `hooks`, `script`), never to `claims`, `copycheck` or
`vision`, and fixed for the life of a process so the prompt cache holds.

**Locked (read-only on the page, with a reason).** `claims`, `copycheck` and `vision` prompts and the
frame-check effort; `publish.*`; `disclosure.*`; `DRY_RUN`; `timezone`; account handles; `render.*`;
`watchdogMinutes`; `creative.mode`; `tiers.clipSeconds`; free-form `t2.params`; tier 1 and
`capsUsd.t1`; `brand.*`; `photo-tags.json`.

**Alternatives.** Editing files over SSH and restarting. A server inside the pipeline process. A
hosted admin or a public TLS port. AdminJS or a JavaScript front end with a build step. YAML or JSON
config replacing D-23.

**Why.** The admin holds no API key in its environment, but it can read the database file that holds the
OAuth tokens, and its environment carries the alert webhook and bot credentials.
Every guardrail sits in the shared loader, so a value written straight into the database is refused
the same way.

**Cost.** One more container (about 100 MB of RAM). The admin can read the database file that holds
the OAuth tokens; its code never queries them (a test checks this).

**Revisit when.** A second person needs access, the page must be reachable without a tunnel, or the
owner wants to try a prompt from the page.

**Later hardening.** Move `oauth_tokens` to a separate database file on a volume the admin does not mount.

**Residual risk (6c review).** The Music page parses untrusted media with FFmpeg inside this container, which can read the OAuth tokens in the database. A parser bug that gave code execution there could read them. What limits it: the demuxer is forced from the first 12 bytes (`-f`), `-format_whitelist mov,wav,mp3` and `-codec_whitelist aac,mp3,mp3float,pcm_s16le,pcm_s24le,h264,mjpeg,png` (the video codecs are there only because a picture or video stream in an mp4 is opened while probing), `-protocol_whitelist file`, `cap_drop: [ALL]`, `no-new-privileges`, a read-only root, `pids_limit: 64`, `mem_limit: 640m`, one upload at a time and a 40 MB cap. Longer-term fix: parse uploads in a separate container with no database volume (only the music volume), and have the admin move the result into place.


## D-33 Posts on demand: made now, held until the owner presses Post (2026-11-14)

**Chosen.** The Posts page has a "Make a new post" button.
- It inserts a manual slot (`slots.kind = 'manual'`, id `<date>#101` and up) with one pending publication per enabled platform, scheduled at the request time. The tick produces it before planned slots, through the normal producer, so the same price, cap and ledger rules apply.
- A manual slot always makes a new clip: it never reuses a stored one, and with no new clip it fails and shows why.
- On commit it is `ready` with `hold = 'waiting'`. `publishDue` does not claim its rows while it waits, and the lateness rule does not skip them.
- Post moves the rows to `MAX(scheduled_at, now)` and sets `hold = 'approved'`. Discard, or no answer within `approval.expireHours` (24), skips the rows and sets `discarded` or `expired`. Each is one compare-and-set transaction on `hold = 'waiting'`.
- At most one manual slot is in production at a time. That makes a double click or a second tab harmless. At most `approval.manualPerDay` (3) are made a day.
- Discarded and expired clips are never reused, and housekeeping deletes them after `keepDays`.

**Alternatives.**
- A new slot or publication state: SQLite cannot alter a CHECK constraint, so this needs a table rebuild under live foreign keys.
- Creating the publications only on Post: the slot would turn `done` at once, and the "too late" rule would fail it.
- The admin asking the pipeline through a request table: one more minute of delay and more code, for no safety gain, since every transition is one guarded statement.
- Holding planned slots: a missed approval would cost a scheduled post.

**Why.** The owner asked on 2026-11-14 for a button that makes a video now and posts only after review. Held rows are never claimed, so they never carry a handle. Skipping them can never hide a sent post.

**Tests.** The hold, approve, discard and expiry tests are in `tests/holds.test.ts`.

**Revisit when.** The owner wants to edit the caption before posting, or wants planned slots reviewed too.

## D-34 Owner music: uploaded on the admin page, mixed under the clip's sound (2026-11-14)

**Chosen.**
- **Upload.** The owner uploads mp3, m4a, mp4 or wav files (at most 40 MB, 5 to 600 s, at most 50 tracks) on the Music page and ticks the tracks to use. The admin container, which holds no API keys, chooses the demuxer from the file's first bytes, never from its name. It probes the file and transcodes it to AAC at `data/music/<sha256 of the upload>.m4a`, with metadata stripped, and measures its loudness.
- **Rotation.** Each `ugc` render takes the ticked track used least recently.
- **Mix.** Remotion's `<Audio loop>` plays the track under the clip's own sound, at `ugc.music.volumeDb` (−18) relative to −14 LUFS. During the first shot, where the prompt places the spoken line, it dips by a further `ugc.music.duckDb` (−10 dB) with 150 ms ramps, and it fades in and out. The existing loudness pass brings the mix to −14 LUFS.
- A track shorter than the video loops. With no track ticked there is no music. A deleted track never breaks a render or a held post.

**Alternatives.**
- An FFmpeg sidechain compressor after the render: the FFmpeg that Remotion ships has no `sidechaincompress`, `acompressor`, `afade` or `aloop`.
- Ducking on measured speech: the clip's room sound has no silences to find.
- Probing uploads in the pipeline container: that is the process that holds the keys.
- The synthesized bed (D-16) when nothing is ticked: kept as a later option.
- Probing with an `ipod` muxer or `lavfi` video sources in tests: Remotion's FFmpeg has neither, so the tests build their media with the muxers and sources it does have (`mp4`, `mp3`, `wav`, `sine`, `anullsrc`).

**Why.** The owner asked for it on 2026-11-14. The spoken line sits in shot 1 by construction (`buildClipPrompt`), so the duck window comes from the concept with no extra analysis.

**Where the code lives.** The admin has its own `musicRoot` and `inside()` path check in `src/admin/media.ts`, so it never loads Remotion. The pipeline side is `src/music/tracks.ts`, `templates/music-volume.ts` and `templates/Ugc.tsx`.

**Residual risk.** Untrusted media is parsed in the admin container, which can read the OAuth tokens (D-32 lists the limits and the fix: a parsing container with no database volume). **Risk.** Copyright: the page says that a matched track can mute or block a post or strike the account, and requires a rights confirmation for each upload. If the model speaks outside shot 1, the music does not dip there. Music files are not in the backups.

**Revisit when.** A post is muted or claimed, or a spoken line is heard over undipped music.

## D-35 Video models from the admin page; the ledger records the live quote (2026-11-14)

**Chosen.**
- **Adding a model.** The Models page adds a Higgsfield model: id, options, the most credits for one clip, and credits to keep. Rows are immutable.
- **Guardrails, applied by the page and again by the loader:**
  - id pattern `^[a-z][a-z0-9_]{1,63}$`;
  - options from a fixed list only (`resolution`, `mode`, `generate_audio`, `sound`, `bitrate_mode`, `genre`, `enable_thinking`), as primitive values, at most 6 keys;
  - resolution 480p, 720p or 1080p, no `video_edit` or `video_extension`, sound never off;
  - `maxCredits` at most `tiers.customMaxCredits` (120); `keepCredits` at least the file's 350.
- **Price.** A custom model's price for the cap checks is `maxCredits × tiers.usdPerCredit`. The provider's existing quote check refuses its first job if the live quote is above the limit.
- **Approval.** A new model can be used only in a manual post (D-33). Pressing Post on one marks it approved, and only approved models can be chosen in Settings.
- **Presets.** Four file presets were added, quoted live on 2026-11-14 with `get_cost` for 15 s, 9:16 and no reference images (the pipeline quotes again with images before every paid call):

  | Preset | Credits | `usdPerClip` | `maxCredits` |
  |---|---|---|---|
  | `seedance_2_0_std_720p` | 67.5 | $1.47 | 75 |
  | `seedance_2_5_flash_720p` | 75 | $1.63 | 83 |
  | `seedance_2_5_720p` | 105 | $2.28 | 116 |
  | `kling_o3_std` | 18.75 | $0.41 | 21 |

  The two Seedance 2.5 presets use `mode: omni_reference`, which reference images need. At $2.28 a clip the $52 monthly cap allows about 22 clips, so the cap stops `seedance_2_5_720p` mid-month.
- **Ledger.** It now records the exact quote the paid call was sent with, times `tiers.usdPerCredit` ($65 / 3,000), and stores the credits. The reserved row keeps the upper bound (the larger of `usdPerClip` and `maxCredits` x `usdPerCredit`, also used by the cap check) until then.

**Alternatives.**
- A pipeline job that quotes a new model before its trial: a second process calling Higgsfield could use a rotated refresh token twice and revoke the sign-in (`higgsfield-auth.ts`, the refresh shortcut).
- Free-form JSON options: the catalogue has options that bill differently or reach other features (`video_edit`, `draft_job_id`, `avatar_ids`).
- Holding the first planned slot of a new model: a missed approval costs a scheduled post.

**Why.** The owner asked to try other models without editing files. Catalogue facts were read with `models_explore` on 2026-11-14. `kling3_0` takes no reference images and is not offered.

**Revisit when.** Higgsfield changes its tools or prices, or a model needs an option outside the list.

## D-36 Overview diagram: ASCII, not Mermaid (2026-11-14)

**Chosen.** The end-to-end diagram in ARCHITECTURE.md is plain text in a `text` fence, at most 98 columns. A table lists every prompt and where it is used.

**Alternatives.** Mermaid, which renders only on GitHub and is hard to read as source. An image, which cannot be diffed.

**Why.** The owner and the build agents read these documents in a terminal.


## Open questions for the owner

1. Tags such as "bestseller" stay out of ad claims (D-21).
2. Claims printed only on the product photos stay out of ads, or the facts are added to the
   Shopify description (D-21).

Settled on 2026-11-12: three employees (D-03), TikTok through the bridge (D-02), Instagram Reels
as the fourth platform (D-27).

## Attempts abandoned

Record here any tool or API dropped after two failed attempts, with the reason.

- **A CC0 music library (2026-11-12).** Two research passes. FreePD.com has shut down. Free Music
  Archive's CC0 filter returned a track whose own page says CC BY-NC-ND. OpenGameArt and Musopen
  refused automated requests, so no track licence could be read from its own page. No track was
  verified. Replaced by synthesized beds (D-16).
- **Higgsfield REST API (2026-11-13).** The key worked for price quotes, but a real submit returned
  `403 not_enough_credits`: it bills a prepaid balance separate from the subscription. Replaced by the
  MCP route (D-30). The `HIGGSFIELD_KEY_*` variables are no longer read.
- **Device-code sign-in for the Higgsfield MCP client (2026-11-13).** The authorization server lists
  the grant, but refuses it for self-registered clients ("does not have the ... device_code grant").
  The sign-in uses the authorization-code flow, with a paste-the-URL fallback for a headless server.
- **Shopify MCP connector at build time (2026-11-12).** Present in the session but not
  authenticated. The public product feed is used instead. Nothing at runtime depended on it.
