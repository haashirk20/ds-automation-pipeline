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
have been the wrong bet. A single idempotent `infra/setup.sh` for Ubuntu 24.04 works on any host.
Serverless would split state and rendering across services to save a VM that costs $10.

**Shortlist.** Hetzner CX33 or CAX21 (about $10–12), Netcup VPS 1000 (about $16), Hostinger KVM 2
($9–15). Oracle Always Free is left out: its reclaim rule targets idle instances and this workload
is idle most of the day. GCP and AWS small instances cost $25–48 for the same shape. The owner
creates the account.

## D-14 Backups: restic to Cloudflare R2 (2026-11-11)

**Alternatives.** Litestream. Provider snapshots.

**Why.** The state worth keeping is one database file under 1 GB that includes the tokens. A
nightly encrypted copy with retention is enough: losing a day loses nothing that cannot be
regenerated. Litestream is a second always-on process. Snapshots are provider-specific and unencrypted.

**Details.** restic backs up a `VACUUM INTO` snapshot, never the live file, which could be copied
mid-write. The restic password and R2 keys are also kept off the VM by the owner. A restore brings
back tokens as they were, so platforms whose refresh tokens rotate are authorized again afterwards.

## D-15 Alerts and monitoring: one webhook plus a dead-man's switch (2026-11-11)

**Alternatives.** Email over SMTP. A self-hosted monitor (Uptime Kuma, Grafana).

**Why.** A Discord or Telegram webhook is one HTTP call with no account to run. It cannot report
that the VM itself is dead, so the loop pings healthchecks.io (free) and that service emails when
the pings stop. A second check there is pinged only when the daily summary has been delivered, so
a dead webhook is noticed too. A self-hosted monitor on the same VM dies with it.

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
The owner can drop licensed tracks into `assets/music/` with a manifest entry and they take
priority. `music.enabled: false` turns music off.

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
  music, because it has no licence to any.
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

**Budget rules.** The ledger stays in dollars: `usdPerClip` is the quoted credits times what a
credit costs on the plan ($65 for 3,000). Before each job the provider reads the live balance and
the server's quote. A quote above `maxCredits` stops the job, and so does a job that would leave
fewer than `keepCredits`. `keepCredits` is set above Higgsfield's auto-refill threshold (300), so
the pipeline cannot cause an automatic purchase if the owner turns auto-refill on.
- Before the paid call, the provider asks for the quote again on the exact request, reference
  images included, and applies `maxCredits` and `keepCredits` to that quote.
- A quote answer that holds a started job, or no positive number, stops clips (fail closed).
- A fetch that fails for any reason other than the job having ended keeps the ledger row
  `submitted`. The slot waits and resumes the same job. Only a job the server reports as ended is
  marked `failed`.
- Known gap: the ledger records the configured `usdPerClip`, not the live quote. The architect's
  finding 8; not fixed.

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
