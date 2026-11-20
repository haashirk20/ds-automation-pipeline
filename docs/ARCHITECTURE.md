# Architecture

Three compose services on a small VM turn the store's Shopify product into two 15-second vertical
videos a day and publishes each one to YouTube Shorts, Facebook Page Reels, Instagram Reels and
TikTok. The pipeline is ordinary code driven by a SQLite database. Language models are called only
at the creative and judgment steps listed under "Model use at runtime". Two things listen on a port: the admin page (published on the
host's `127.0.0.1` only) and a loopback listener for the one-time Higgsfield sign-in.

Two creative formats exist, chosen by `creative.mode` (D-28). `ugc`, the default, is one
AI-generated 15-second scene that looks like something a person filmed, with one caption at the top
of the frame. `ad` is the earlier photo ad: a scripted voice-over over animated product photos, with
an end card. Everything outside the creative step is shared.

## What we are advertising

Read from the live store on 2026-11-11:

| | |
|---|---|
| Store | Giftwell (formerly Merry Marts), Oakville, Ontario. Prices in CAD. Ships to Canada only |
| Products | 1: Heated Shawl Wrap (`snugwrap-heated-shawl-wrap`), $49.99 CAD |
| Variants | Beige, Green, Red. One size, 150 × 80 cm |
| Photos | 10, square, 800–1500 px. Six are supplier infographics with claims printed on them |
| Description | About 60 words: heating function, USB-powered, wearable, materials, gift-box packaging, "Power bank not included" |
| Reviews, sale price | None |

Three consequences shape the design. The facts available for claims are few, so the claim checker
matters, and every post carries the brief's disclosure ("power bank not included") in its text. One
product has to carry 60 distinct videos a month, so variation is part of the system. And most photos
carry printed text, so each photo is cropped to a text-free region before it is used or sent out.
What the product looks like is not in Shopify's data, so the owner writes it in
`config/product-notes.json`.

## Diagram

The whole flow, top to bottom. Text boxes name the config key of the model that reads them.

```text
 OWNER (browser over an SSH tunnel or Tailscale)
   |
   v
 admin container -- no API keys, read-only root, own network, 127.0.0.1:8080 only
   pages: Overview  Factory  Settings  Prompts  Posts  Music  Models  Activity  History
   writes: config_versions, text_versions (house video ugc copy hooks script note:*),
           manual slots and hold decisions, music_tracks + data/music/*.m4a, video_models,
           kv auto_paused (Stop / Start daily posts, D-45)
   reads:  out/ renders (read-only) for the preview player; runs ffmpeg on uploads
   |
   v  SQLite data/pipeline.db (WAL): the only channel; the pipeline rereads it every tick
   |
 pipeline container -- one process, one tick every 60 s (src/scheduler/loop.ts)
   1 config = file + active override; prompts = files + active versions
   2 plan tomorrow's slots at produceAt      3 start one producer child (manual first)
     (2 and 3 skip daily posts while kv auto_paused is set; manual slots still run)
   4 holds: alert waiting, expire old        5 publishDue
   6 snapshot, housekeeping, daily summary, heartbeat, healthchecks.io ping
   |
   v  produce --slot ID  (child process; every write fenced by the claim time)
 Shopify Admin API or /products.json --> brief: facts with sources, disclosures, photos
 config/photo-tags.json --> text-free crops of the photos
   |
   v
 CONCEPT WRITER    llm.models.script   system: house + ugc + brief
                                       user: length, month, product note, recent captions
   | code checks: numbers, prices, banned phrases, repeats
   v
 CLAIM JUDGE (locked)  llm.models.copy  system: claims + brief   user: caption, spoken line
   v
 CLIP PROMPT (code)  video text + setting + person + product note + photo notes + shots
                     + the speech sentence (kept in code)
   v
 HIGGSFIELD MCP  balance, quote, upload references, quote again, one paid job, download
                 ledger row before submit; live quote x usdPerCredit recorded
   v
 FRAME CHECK (locked)  llm.models.qa  system: vision + brief
                       user: 8 frames, reference photos, product note; verdict in code
   v
 CAPTION RENDER  Remotion Ugc: clip + caption + owner track (rotated, dips in shot 1)
                 -> loudness -14 LUFS -> QA gate (10 checks)
   v
 COPY WRITER   llm.models.copy  system: house + copy + brief   user: what the video shows
 COPY JUDGE (locked)            system: copycheck + brief      user: the copy
   v
 COMMIT  one transaction: slot ready, one render row per platform
         manual slot: hold waiting until the owner presses Post or Discard
   v
 PUBLISH  claim row, saveHandle, POST /posts with Idempotency-Key <slot>:<platform>
          (DRY_RUN=1 skips only this call)
   v
 Zernio bridge --> YouTube Shorts | Facebook Page Reels | Instagram Reels | TikTok

 ad mode instead of concept..render: HOOKS (house + hooks), SCRIPT (house + script),
   CLAIM JUDGE (claims), Kokoro voice, synthesized bed, Ad template per platform, QA
 planned, not built: WEEKLY REVIEW (Phase 8) -- no prompt and no code exist yet
 side outputs: alerts to Discord or Telegram; backup container -> restic -> R2
```

### Every text a model or the clip service receives

| Text | Source | Editable on the page | `house` first | Model (config key) | Where it is used |
|---|---|---|---|---|---|
| `house` | `prompts/house.md` | yes | n/a | none | Prepended to `ugc`, `copy`, `hooks`, `script` |
| `ugc` | `prompts/ugc.md` | yes | yes | `script` | `creative/ugc.ts`, concept |
| `copy` | `prompts/copy.md` | yes | yes | `copy` | `creative/copy.ts`, titles, captions and hashtags |
| `hooks` | `prompts/hooks.md` | yes | yes | `script` | `creative/hooks.ts` (ad) |
| `script` | `prompts/script.md` | yes | yes | `script` | `creative/script.ts` (ad) |
| `video` | `prompts/video.md` | yes | no | Higgsfield, not a language model | First paragraph of `buildClipPrompt` |
| `note:<handle>` | `config/product-notes.json` | yes | no | none | Concept user text, clip prompt, frame-check user text |
| `claims` | `prompts/claims.md` | locked | no | `copy` | `creative/claims.ts` |
| `copycheck` | `prompts/copycheck.md` | locked | no | `copy` | `creative/copy.ts` |
| `vision` | `prompts/vision.md` | locked | no | `qa` | `qa/vision.ts` |
| speech sentence | code in `buildClipPrompt` | no | no | Higgsfield | Last line of the clip prompt |
| weekly review | none (planned) | n/a | n/a | n/a | Phase 8 |

Every system text ends with the brief JSON (`systemPrompt`).

## Data flow for one slot

### `ugc` mode (default)

1. **Plan.** The planner creates a slot row and one publication row per enabled platform for each
   slot time that is still in the future. The tick plans tomorrow from `produceAt` (21:00 local) and
   plans today if it has no slots. The planner makes no creative choices.
2. **Produce.** The tick starts `produce --slot` in a child process for the oldest planned slot.
   `produceSlot` claims it with one atomic update and the claim time fences every later write.
3. **Ingest.** The store is read at most hourly, under a five-minute deadline that aborts the read:
   by the scheduler tick (started and not waited for, one read at a time) and by the producer before
   it picks a product. The owner's "check now" on the Products page writes `kv ingest_requested`,
   which makes the next tick read the store before the hour is up; the admin never reads the store
   itself (D-32, D-40). The product for the slot is then chosen by `pickBrief` (per-post lists, else
   the ticked products, else every product). The Admin
   API is used when `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set, and the public feed
   when they are not or when the Admin call fails. The result becomes a brief: facts with the field
   each came from, disclosures, and a photo inventory. A failed ingest alerts and the stored brief
   is used. With no stored brief the slot goes back to `planned`.
4. **Tier.** `chooseTier` draws a tier from the slot id. With the default mix every slot draws
   tier 2. It falls back to tier 0, which means "reuse a stored clip", when the provider is not
   signed in or the monthly cap is reached. A manual slot (see "Posts on demand") is forced to
   tier 2, and the model is the one chosen on the Posts page.
5. **Concept.** The script model writes a concept as structured JSON: a setting, one woman, a
   product colour, one caption of at most 12 words, at most one spoken line of at most 9 words, and
   three to five shots whose seconds add up to the clip length. Code checks the caption and line
   against the brief (numbers, any price: a currency sign or the shop's currency code next to a digit, banned phrases, repeats of recent captions), then the claim
   judge checks that no statement is unsupported. One retry lists the problems. The accepted concept
   is stored in `slots.master_json` before any paid job starts, so a crash leaves the concept the
   job was made from.
6. **Clip.** The prompt is built from the concept, the owner's product note, up to two cropped
   product photos in the concept's colour, and the logo from `brand.logo`. The router checks price
   and balance, then submits one job to Higgsfield and waits for the video. The clip must be at
   least 14 s with a short side of at least 480 px.
7. **Frame check.** A model looks at eight frames of the new clip against the product photos and
   the owner's note. The verdict is computed in code from its answers (see "QA gate"). A clip that
   fails is rejected, and the slot may start one more job, up to `tiers.maxJobsPerSlot` jobs in
   all, each with a new concept.
8. **Caption render.** Remotion draws the one caption over the clip, below the tallest top safe
   zone of the enabled platforms. If the owner has ticked music tracks, the least recently used one
   is mixed under the clip's sound and dips during shot 1 (D-34). The audio is normalized to
   −14 LUFS. The file goes through the QA gate. A file that fails counts as a rejected clip.
9. **Reuse.** If no new clip could be made (tier 0, cap reached, credits low, signed out, concept
   writer failed, or every job rejected), the slot reuses a stored clip of the product that was last
   posted at least `ugc.reuseAfterDays` days ago, with the concept it was made from. The concept
   must still pass the checks against the current brief. The slot sends a `degraded` alert, then
   renders and checks the clip again. With none available the slot fails and alerts (or waits, if
   the cause was a passing model outage). It does not fall back to a photo ad. A manual slot never
   reuses a clip: with no new clip it fails and shows why. Clips of discarded or expired holds are
   never reused.
10. **Copy.** The copy model writes the title, caption and hashtags for the four platforms in one
    call and a second call judges them. Code adds the product link where captions are clickable
    (YouTube, Facebook) and the brief's disclosures. If the model fails, deterministic copy from the
    brief is used.
11. **Commit.** The one rendered file is copied once per enabled platform. In one transaction the
    slot becomes `ready` and the render rows are written, fenced by the claim time. For a manual
    slot the commit also sets `hold = 'waiting'`. The slot's cost is the sum of its model calls and
    its ledger rows.
12. **Publish.** At each platform's time the publisher posts the file through the bridge (see
    "Never double-post"). The AI label is always on, because every video is AI-generated.

A frame-check error, meaning the model call itself fails rather than the clip being judged bad,
does not lose the paid clip. A rate limit or 5xx puts the slot back to `planned` without using an
attempt. Any other error does so while `attempt < render.maxAttempts`. The next attempt finds the
paid clip in the ledger and the concept in `master_json`, and so does not pay twice. See "Retry".

### `ad` mode (alternative)

The same steps 1, 2, 3 and 10 to 12 apply. In between:

- **Hook.** The hook library is refilled by the script model, and the least recently used hook
  outside its `hooks.noRepeatDays` window is picked. If the model is unavailable or no hook is free,
  the slot reuses the script of an old slot that still passes every check, and alerts.
- **Script.** The script model writes four beats (hook, benefit, offer, call to action) as
  structured JSON. Code checks word counts, price strings and banned phrases, then the claim judge
  checks each chunk against the brief. One retry lists the problems.
- **Tier.** Some slots open with one image-to-video clip made from a product photo. Any failure
  leaves the slot at tier 0. The default config draws tier 2 for every slot, so for `ad` mode set
  the mix to all tier 0.
- **Voice.** Kokoro synthesizes the lines on the VM and returns word timings. If speech runs past
  the limit it is synthesized again at up to 1.12 times speed. If it still does not fit, the script
  is regenerated once, and then the slot fails.
- **Master edit.** The script, shots, voice, music and clip are assembled into one edit list.
- **Render.** Remotion renders the edit once per enabled platform, changing only the safe zones and
  the call-to-action wording, and each file goes through the QA gate and a caption-style check. A
  failure renders the whole slot again with the next template, once.

## Runtime shape

Three services, started with `docker compose up -d` and restarted by Docker
(`restart: unless-stopped`). `pipeline` is built from the repository; its command is
`node src/cli.ts run`, and compose sets `DRY_RUN=1` unless the environment says otherwise.
`pipeline` listens on no port. `admin` is the same image running `node src/cli.ts admin serve`
(see Admin). `backup` is the official restic image running `infra/backup.sh` (see Operations). It shares no
code and no secrets with `pipeline`; the only link is the `backup-status` volume, read-only in
`pipeline`.

The process runs a tick once a minute. Every job reads the database to decide whether it has work,
so a crash, a restart or a missed minute changes nothing. A tick that runs longer than
`watchdogMinutes` (45) makes the process exit so Docker restarts it. The platforms post one after
another, so the config check requires `watchdogMinutes` to be at least 4 × `publish.timeoutMinutes` + 5,
and `publishDue` claims no further row once the tick has run `watchdogMinutes − timeoutMinutes − 2`
minutes; those rows wait for the next tick.
The watchdog is not armed for `run --once`, whose tick waits for every producer and each producer has
its own timeout. A producer child gets `--now` only when the clock is overridden, read from the
override clock when the child starts, so a later child of `run --once` never runs behind.

| Step in the tick | Does |
|---|---|
| Stopped by the owner | `autoPaused(db)` (`kv auto_paused`, D-45) is read at the start of the tick and of `publishDue`. While it is set: no planning, no production of `kind='planned'` slots (manual ones still run), a planned slot past lateness fails quietly as `paused`, and `publishDue` claims no new row of a planned slot. A row with a stored handle still runs and stale recovery is unchanged, so an earlier attempt is always reconciled. Overdue rows of planned slots without a handle are skipped quietly as `paused`. Holds, snapshot, housekeeping, summary, ingest and heartbeat run as usual. The stop is read live before each claim and each producer start. On Start the key is deleted and planning resumes on the next tick; held rows still within lateness go out, ones already past it were ended as `paused` |
| Plan | Creates slot and publication rows as described above |
| Stale recovery | A `producing` slot not touched for `render.produceTimeoutMinutes` (90) goes back to `planned`, or fails with an alert once `attempt` reaches `render.maxAttempts` (2) |
| Produce | Starts one child process for the oldest planned slot if none is running, a manual slot first. A planned slot that has an error waits 10 minutes after the attempt ended (not after it was claimed). A planned slot with no pending publication inside the lateness window fails as "too late" |
| Holds | `holdsTick`: sends `approval_waiting` for each held slot not yet alerted, and expires holds older than `approval.expireHours` (24) |
| Publish | `publishDue`: recovers stale rows, skips overdue ones, posts the ones due |
| Snapshot | Once a day after `ops.snapshotAt`: a consistent copy of the database for the backup service. Failure alerts `snapshot_failed` |
| Housekeeping | Once a day after `ops.snapshotAt`, then the disk check, which alerts `disk_full` above `ops.diskAlertPercent` |
| Summary | After `ops.summaryAt`: the daily summary, then the second dead-man's ping |
| Ingest | `ensureIngest`: reads the store when an hour has passed since the last attempt or `kv ingest_requested` is newer. Started without waiting, never two at once; aborted at five minutes. Writes `kv shop_sync_result` after every attempt. Alerts `ingest_failed`, `shop_empty` and `shop_truncated` (rate-limited) |
| Heartbeat | Written at the start of the tick, so a long publish still shows the loop alive. The end of the tick pings `HEALTHCHECK_URL` if set |

Rendering runs in a child process so that an out-of-memory kill takes the child and not the loop,
and publishing continues while a render is in progress. The produce timeout is 90 minutes, enough
for two video jobs of 40 minutes each (25 of polling, 10 of download, uploads and margin; the config refuses less than `maxJobsPerSlot * 40 + 10` in `ugc` mode). After the
timeout the child gets SIGTERM,
which cancels its Chrome, and 20 seconds later its whole process group gets SIGKILL. `run --once`
produces every planned slot before it publishes, which is how the dry run is exercised.

CLI commands: `run [--once]`, `plan`, `publish`, `produce --slot ID`, `ingest [--print]`,
`samples`, `doctor`, `health`, `after-restore`, `auth higgsfield`, `admin serve` and `admin password`. `--now ISO` moves the clock. Only `cli.ts`
reads the clock.

There is no cron, no Redis and no queue broker. The only web server is the admin page, in its own
service. The database is the queue.

## Posts on demand

The Posts page (D-33) makes one video now and posts it only after the owner presses Post. Only
manual slots are held. Planned slots never wait for a person.

```
manual slot:  planned -> producing -> ready + hold waiting --Post--> approved -> publish -> done
                  |                       |--Discard--> discarded (rows skipped) -> done
                  |                       \--expireHours--> expired (rows skipped, alert) -> done
                  \-> failed (no new clip: never reuses; rows skipped by publishDue)
```

A manual slot is a normal slot with `kind = 'manual'`, id `<date>#101` and up, and one `pending`
publication per enabled platform scheduled at the request time. `src/scheduler/holds.ts` holds the
database-only functions the admin and the loop share: `planManual`, `approveHold`, `discardHold`
and `holdsTick`. Each is one transaction, and approve and discard compare-and-set on
`hold = 'waiting'`.

- **One at a time.** `planManual` refuses while another manual slot is `planned` or `producing`, so
  a double click or a second tab makes one slot. It also refuses past `approval.manualPerDay` (3) a
  local day, with no platform enabled, and outside `ugc` mode.
- **Lateness.** A manual slot must start producing within `maxLatenessMinutes` of the request: the
  loop's "too late" rule and stale recovery fail the slot, because `scheduled_at` is the request time.
  `publishDue` does not skip the rows of a manual slot that is still `planned` or `producing`, so
  the slot is failed, not its rows alone. While it is held the rule is off. Post moves `scheduled_at`
  to the later of its value and now. If no pending row is left to move (a platform was switched off
  or the rows were skipped), Post is refused with "Nothing to post" and the hold stays.
- **Pause.** The button is refused with no platform enabled. A platform switched off later is
  skipped by the existing rule.
- **Not claimed while held.** `publishDue` claims only slots whose `hold` is null or `approved`, and
  it does not treat a `waiting` slot as overdue. Held rows are never claimed, so they never carry a
  handle. Every skip writes with `handle_json IS NULL`, and approval touches only pending rows with
  no handle. The publisher path is unchanged.
- **Discarded and expired clips** are not offered for reuse, and housekeeping deletes them after
  `ops.keepDays`. A held render is kept, because its rows are pending.
- **Deleting a music track** never affects a held render: the mix is already in its file.
- **Planned slots.** `hasSlots` counts only `kind = 'planned'`, so a manual slot does not stop
  today's planned slots from being made.
- **Crash points.** Plan, commit, approve, discard and expire are each one transaction. The waiting
  alert is sent by the tick from the events table, so it goes out even after a crash. A paid call
  followed by a crash before the submitted write takes the existing reserved-to-failed path and
  counts at `usdPerClip`.

The admin never calls Higgsfield and never produces: it writes the slot row and the tick does the
rest.

## Admin

A second compose service, `admin` (D-32), gives the owner a page to change settings and prompts. It
runs the same image and shares the `pipeline-data` volume (SQLite in WAL mode). It has no `env_file`
and so no API key in its environment: only the three `ALERT_*` variables, for the lockout alert. It can
still read the database file that holds the OAuth tokens (later hardening: D-32). Inside the container it listens on 0.0.0.0:8080; the host publishes
`127.0.0.1:${ADMIN_PORT:-8080}` only, and the service sits on its own network. The owner reaches it by
SSH tunnel or Tailscale.

**Edits.** The config file holds defaults and ceilings. The database holds sparse, numbered
overrides (`config_versions`) and prompt versions (`text_versions`), with the active one named in
`kv`. `src/config/overrides.ts` merges an override into the file object and runs the same zod
schema and guard rules (ceilings, floors, whitelists, cross-field rules) in two places: the admin
before it saves, and the pipeline on every tick and in each producer. A stored override that fails
falls back to the file and sends `config_invalid`. A tick reads the active version at its start; a
producer keeps the snapshot it loaded. Each save is one transaction, checks the version the form was
based on, and writes an `audit` row. Rollback activates an older version; "Use file" removes the
pointer. Prompts: `claims`, `copycheck` and `vision` are locked; `house` is prepended to the writer
prompts only; `video` is the Higgsfield style text and the speech sentence stays in code.

Four pages write more than settings. **Products** (D-39) ticks which products get videos, adds
products by hand (form fields in `owner_products`, the brief in `briefs`, photos under
`data/assets/own-*/`) and uploads the logo (`data/brand/logo-<sha256>.png`, named in `kv brand_logo`),
which replaces the file logo as the video model's reference. **Posts** (D-33) makes a manual slot, plays the held render
and records Post or Discard. **Music** (D-34) takes uploads and ticks tracks. **Models** (D-35) adds
Higgsfield models, whose guardrails the page and the pipeline's loader (`src/config/models.ts`)
both apply. A model added there appears in Settings only after one of its manual test posts has
been approved.

The admin container mounts the `pipeline-out` volume read-only at `/app/out` (`OUT_DIR`) so that
the Posts page can stream a held render to the player, and it has 640 MB of memory. Streaming
(`/media/render`, `/media/music`) answers `Range` with 206. A file is served only if it is a regular
file inside `OUT_DIR` or `data/music` after symlinks are resolved (`inside()` in
`src/admin/media.ts`). Approve refuses when any of the slot's render files is outside `OUT_DIR`.
The admin keeps its own `musicRoot` and path check, so it never loads Remotion.

**Music uploads.** The one multipart route is `POST /music/upload`. Untrusted media is parsed here
and not in the pipeline container, which holds the keys. The session is checked before any body is
read and the CSRF field after parsing. The file type comes from the first bytes, with a forced
demuxer (`mov`, `mp3` or `wav`) and `-protocol_whitelist file`, never from the name. The file is at
most 40 MB and 5 to 600 s, and at most 50 tracks are kept (a 51st is refused). ffprobe measures it,
and ffmpeg transcodes it to AAC with metadata stripped at `data/music/<sha256>.m4a`, after which
loudness is measured. The upload needs a rights confirmation.

**Security.** One admin, a scrypt hash in `kv`, a session cookie (`HttpOnly`, `SameSite=Strict`,
stored as a hash), a Host allow-list against DNS rebinding, Origin and `Sec-Fetch-Site` checks and a
per-session CSRF token on every POST, a login lockout, form-encoded bodies of at most 256 kB (the music upload is the one
exception: 40 MB plus 64 kB), and a CSP with no script source. Pages are server-rendered with no client JavaScript and escape every
database value. The exceptions are the read-only Factory page (D-37) and the town square at `/town`
(D-43), whose CSPs allow their own `/factory.js` or `/town.js` and fetches to the same origin. Every page
loads `/style.css`, Factory and the town included (D-44); their own stylesheets only add the layout around the canvas. Destructive actions
open a `<details>` confirmation first, so no script is needed for them.
Product photos and the logo are image uploads with the same handling as music: PNG or JPEG sniffed
from the first bytes, ffmpeg with the image demuxer, a forced decoder and a file-only whitelist, and a
re-encode to PNG without metadata. The code never queries `oauth_tokens` (a test checks this).

## Slot and publication states

```
slot:         planned -> producing -> ready -> done
                 ^           |  \-> failed          (alert; publications skipped)
                 \-----------/  back to planned: stale claim, no brief,
                                a passing outage, or a retry after a paid clip

publication:  pending -> uploading -> published
                 |            \-> pending (retry with backoff)
                 |            \-> skipped (permanent error or retries exhausted, with no handle)
                 |            \-> needs_attention (ambiguous, or a handle is stored; alert; never re-posted blindly)
                 \-> skipped (slot failed, or more than maxLateness past its time, with no handle)
                 \-> skipped (platform disabled, no handle; logged, no alert)
                 \-> needs_attention (the same two cases, with a handle stored)
```

A planned slot whose pending platforms are all switched off waits, and nothing is spent. Past
`maxLatenessMinutes` it becomes `failed` with error `paused` and raises no alert.

A slot ID is `<local date>#<index>`, for example `2026-11-12#1`. A publication is keyed by
`(slot_id, platform)`. A slot becomes `done` when none of its publications is `pending` or
`uploading`.

**Claiming.** A publication is claimed with one statement,
`UPDATE … SET state='uploading', claimed_at=… WHERE state='pending'`, and the post goes ahead only
if that statement changed a row. The claim time is a fencing token: every later write to the row
names it, and a write that no longer matches is dropped. The same holds for slots, with
`claimed_at` on `slots`. A manual `publish` beside the loop cannot take the same row. Posting is
serial and one call can take minutes, so each claim, the published time and a retry's
`next_attempt_at` are read from the clock when they happen, not from the tick start.

**Recovery.** A crash can leave a row in `producing` or `uploading`. Rows older than their timeout
(`render.produceTimeoutMinutes` for slots, `publish.uploadTimeoutMinutes` for publications, 90 and 30
minutes) are taken over. A stale `uploading` publication with no stored handle goes back
to `pending` with its attempt count unchanged, because nothing was posted and the next claim counts
the attempt. One with a handle is run again, which resumes from the
handle. If it is also past `maxLatenessMinutes`, or has used more than `retryMinutes.length + 1`
attempts, it becomes `needs_attention`. A stale row is left alone in a dry run.

### Never double-post

The bridge publisher (`src/publish/bridge.ts`) follows the contract in `src/publish/types.ts`: call
`saveHandle` before any request that could create a post, use the stored handle first on every call,
and pass `signal` to every request. No stored handle means nothing was posted.

1. The handle is `{ mediaUrl, at, postId? }`.
2. With a `postId`, the publisher only reads the post (`GET /posts/{id}`) and polls every 10 seconds
   until the platform's status is `published`, `failed` or `cancelled`. It stops after nine polls
   (90 seconds) with a retryable "still publishing", and the next attempt reads the stored post
   again. A post that cannot be read while we hold its id is `needs_attention`. It never sends a
   second create request.
3. With a handle but no `postId`, the create request may have been sent. If the handle is more than
   23 hours old, the bridge may have forgotten the key (it keeps it 24 hours), so the result is
   `needs_attention`. Otherwise the request is sent again with the same key.
4. With no handle, the publisher finds the account by handle, uploads the video to a pre-signed URL
   if needed, and calls `saveHandle({ mediaUrl, at })`. Only then does it send `POST /posts`.
5. The create request carries `Idempotency-Key: <slot id>:<platform>`, which is stable across
   retries. A 409 that names an existing post is adopted: its id is stored and read back. The post id
   is saved as soon as the response arrives.
6. A post the bridge reports as failed or cancelled is final and is not retried: a missed post is
   acceptable, a double post is not.
7. A publication with a stored handle is never marked `skipped`. When retries run out, or it is too
   late or its slot failed, it becomes `needs_attention`, because a request may have been sent.

If the state cannot be resolved (unreadable handle, expired key, a render missing after a handle was
stored, an unexpected error), the publication becomes `needs_attention` and an alert goes out.

### Retry

A network error, a timeout, HTTP 5xx or 429, and an idempotency conflict are retryable. The row goes
back to `pending` with `next_attempt_at` at 1, 5, 15, 45 and 120 minutes (`publish.retryMinutes`).
When that list is exhausted the publication is `skipped` with an alert, or `needs_attention` if a
handle is stored. Any other 4xx, a missing
bridge account, a post the bridge reports as failed, and a refused `private` Instagram post are
permanent: the publication is `skipped` and an alert goes out, or `needs_attention` if a handle is stored. A publication more than
`maxLatenessMinutes` (360) past its time is skipped, so a long outage never produces a burst of
posts. One publish call is cut off after `publish.timeoutMinutes` (10), which is less than the
30-minute recovery timeout. The video upload inside it is cut off at 6 minutes.

**Retry of a slot.** A passing outage (a model rate limit or 5xx, a paid clip that cannot be fetched
yet) puts the slot back to `planned` and gives back the attempt, with one `degraded` alert. A clip job is waited for at most 2 hours after it was created; then it is marked `failed` and the slot uses a stored clip. A concept-writer outage with no stored clip gives the attempt back once per slot; a repeat uses it. The
same holds for no stored brief, with an `ingest_failed` alert. Any other error after a clip was paid for does the same while `attempt < render.maxAttempts`,
but uses the attempt. So does a clip request that failed before the paid call (`NotSentError`, below). Any other error fails the slot. The tick waits 10 minutes before it tries a
planned slot that has an error, and the "too late" rule ends the wait (D-31).

## Creative pipeline

**Brief.** Built from Shopify data, or for a product the owner adds on the Products page from the fact
lines they type (source `owner`, D-39); such a brief has no tags and allows no discount or review
claims. Products take turns by slot ordinal among the ones ticked on that page (`kv products_active`;
none ticked or a stale tick means all). Each fact records its source field. Tags are used for
angle selection and never as claims. Each photo's usable shots come from `config/photo-tags.json`,
which the owner edits: a crop free of printed text, what it shows and the colour variant. A photo
with no entry is used whole. Tagging photos with a vision model is planned and not built. Claims that
appear only as text printed on a photo are never used. The brief also extracts disclosures.

**`ugc` concept.** See steps 5 and 6 above. The caption and the spoken line may state an opinion,
never a fact the brief lacks. The woman is a character in a scene and is never presented as a
customer giving a review. The picture carries no price, logo overlay, end card or call to action.
The video model makes the voice and the room sound, so there is no voice-over and no synthesized
music bed. The owner may upload tracks and tick them on the Music page (D-34): `ugc` mode then mixes
the least recently used ticked track under the clip, at `ugc.music.volumeDb` (−18), dipping by
`ugc.music.duckDb` (−10) during shot 1, where the prompt puts the spoken line. The spoken line is not
transcribed at run time (D-28).

**Caption render.** `templates/Ugc.tsx` draws one caption, `ugc.captionPx` (84) wide on the
1080-pixel frame, below the tallest top safe zone plus 30 px. One render serves every platform.

**`ad` mode only.**

- *Hook library.* The script model writes hooks in six frameworks. A hook is usable if no slot has
  used it in `noRepeatDays` (14). The library floor is `noRepeatDays × slots per day × poolFactor`
  (14 × 2 × 1.5 = 42), and it is refilled by 24 whenever it is below the floor.
- *Script.* Four beats: hook, benefit, offer, call to action with shop name and URL. Each caption
  chunk has what is said ("forty-nine ninety-nine") and what is shown ("$49.99").
- *Voice and caption timing.* Kokoro-82M runs through a small Python CLI and returns a WAV plus
  per-word times. Captions are the script itself, timed by the synthesizer. Speech must end by
  14.8 seconds.
- *Music.* (`ad` mode only; owner tracks are not used here.) A small Python tool synthesizes an instrumental bed from the slot's seed. Music is ducked
  under the voice and the mix is normalized to −14 LUFS.
- *Render.* A Remotion composition takes the master edit as props. Three templates exist: bold
  kinetic type, soft lifestyle, and gift-guide cards. The end card shows the exact price string from
  Shopify, the shop name and the product URL.

## Variation

In `ugc` mode variation comes from the concept writer, which is given the last 20 captions and
settings and the ones rejected in this slot and may not reuse them, and from the stored-clip rule
for reuse. A caption that repeats a recent one after case and punctuation are removed is rejected.

In `ad` mode a slot is a point in this space, and the variant is a pure function of the slot id:

| Dimension | Rule |
|---|---|
| Hook | Not used by any slot within 14 days |
| Template | Never the previous slot's template |
| Palette | Chosen from three per template |
| Voice | Rotates through `creative.voices` by slot order |
| Music | A seed from the slot id |

Learned weights are planned (see "Feedback loop").

## Feedback loop

Planned. Nothing here is built: there is no `metrics` table, no `src/feedback` and no `metrics` or
`review` command.

Weights would be computed in code. The model would not set them.

- **Metric.** Per post: average watch time divided by video length, where the platform reports it.
  Otherwise likes plus comments plus shares, divided by views. Metrics are read 48 hours after
  publishing.
- **Normalizing.** A post is a win if it beats the median of the last 30 days on its own platform.
  Platforms are never compared with each other.
- **Sampler.** Thompson sampling over hook framework and template, each with a win and a loss count.
  The `hooks` table already has `wins` and `losses` columns.
- **Pruning.** A hook with three losses and no win is retired.
- **Review.** Once a week the script model reads the results table and writes a short commentary and
  angle suggestions.
- **Gaps.** A platform without readable metrics is left out of the ranking. The bridge offers
  analytics (`GET /v1/analytics`; views, likes, comments and shares for YouTube and TikTok), read
  from its documentation and not yet called (D-29).

## Tier router and budget

| Tier | Meaning | Provider | Default share |
|---|---|---|---|
| 0 | No new clip. `ugc` mode reuses a stored clip. `ad` mode uses photos only | none | 0% |
| 2 | A premium-model clip made on the owner's Higgsfield subscription credits | Higgsfield MCP server | 100% |

Tier 1 (an open-weight clip) was removed, since no provider was ever written (D-42). The tier is drawn
from a hash of the slot id and the mix.

**Provider.** `src/router/mcp.ts` is a minimal MCP client over `fetch` (JSON-RPC, no model, no SDK).
`higgsfield-auth.ts` signs the owner in once with `node src/cli.ts auth higgsfield` (authorization
code with PKCE, the client registers itself) and keeps the tokens in `oauth_tokens`. A refused access
token is refreshed once and the call retried, except the paid call. `higgsfield.ts` is the provider.
The default model is Wan 3.0 at 720p with generated audio, 15 seconds, 9:16.

**Credits and the ledger.** The ledger is in dollars. A row is reserved at the upper bound, the larger of the configured
`usdPerClip` and `maxCredits` times `tiers.usdPerCredit`, which the cap check also uses. When the job is submitted the row stores the exact quote the paid
call was sent with (`credits`) and its price is those credits times `tiers.usdPerCredit` ($65 per
3,000 credits). A crash after the paid call and before that write therefore counts the worst case
(D-35). Before a new job the provider reads the live balance and asks the server for the quote. Just
before the paid call it asks again for the exact request, reference images included. The job is
refused when that quote is above `maxCredits` (30) or when the balance after it would be below
`keepCredits` (350), which sits above Higgsfield's auto-refill threshold so the pipeline cannot
trigger an automatic purchase. A quote answer that holds a started job, or no positive number,
stops clips. A refusal alerts once a day and the
slot reuses a stored clip. A failure before the paid call (the balance read, the image uploads, the
confirm, a quote answer without a usable number) is a `NotSentError`: its ledger row becomes `failed`
at $0 with an error starting `not sent:`, and does not count toward `maxJobsPerSlot`. A quote call
with images that fails in transit may have started a job, so its row stays at the reserved price. A limit refusal at that point alerts like the first check; any other
such failure sends the slot back to `planned` while attempts remain. With no stored sign-in the tier falls back to 0 without an alert. If the
stored sign-in is refused and cannot be refreshed, a `clip_sign_in` alert goes out.

**Monthly cap.** `tiers.capsUsd` limits each paid tier per UTC month. The month's total counts every
ledger row of the tier, in any state, at its quoted price, so failed and rejected jobs count. A draw
that would pass the cap falls back to tier 0 and alerts once for that month. A slot that already has
a `submitted` or `succeeded` job keeps its tier even at the cap, so a job that was paid for is
always fetched.

**One job at a time, never twice.** The ledger row is written before the job is submitted, and the
provider's job id is stored on it before the router waits. Per slot, `generateClip` goes in this
order:

1. A `succeeded` row whose file exists: copy the file and return. This is how a retry reuses a paid
   clip.
2. A `submitted` row: fetch that job and never submit another. If the fetch fails for a reason
   other than the job having ended, the row stays `submitted`, the slot goes back to `planned` and
   the same job is fetched next time. If the provider is signed out, the slot waits the same way
   and a sign-in alert goes out. Only a job the server reports as ended (a failed or cancelled job,
   no result URL, a disallowed result host, an oversize file) is marked `failed`.
3. A `reserved` row means a crash between reserving and storing the job id. It is marked failed and
   nothing is submitted, because whether the job exists is unknown.
4. Otherwise a new job, only if the slot has fewer than `maxJobsPerSlot` (2) rows, the provider is
   signed in and the cap allows it.

`generate_video` has no idempotency key, so a call whose outcome is unknown is never repeated and a
crash at that moment can cost one clip. A failed or rejected job counts at its quoted price. A job
is polled for at most 25 minutes per fetch (a deadline, not a poll count), and the result is downloaded only from an https host on Higgsfield's
or CloudFront's domain, at most 300 MB.

The ledger is the first limit. The second is outside our code: the Anthropic workspace has a spend
limit equal to the model cap, and the Higgsfield plan grants a fixed number of credits a month.
Unverified: that the workspace limit is set.

## QA gate

Nothing is published without passing. `runQa` reads the finished file and reports ten checks; if
the file cannot be read, all ten fail.

| Check | Tool | Pass condition |
|---|---|---|
| Container, video, audio | `ffprobe` | MP4; one H.264 `yuv420p` stream, 1080×1920, 30 fps; one AAC stream at 48 kHz |
| Duration | `ffprobe` | 14.0–16.0 s |
| File size | `stat` | More than 500 kB and at most 100 MB |
| Fast start | MP4 atom order | `moov` before `mdat` |
| Loudness | `ffmpeg` `loudnorm` in measure mode | −14 ±1.5 LUFS, true peak at most −0.7 dBTP |
| Silence | `ffmpeg` `silencedetect` | None longer than 1.5 s |
| Black frames | Every frame decoded to 32×57 greyscale; mean brightness in code | No dark run longer than 0.3 s |
| Frozen picture | The same frames; difference between neighbours | No still run longer than 2.5 s |

`ad` mode adds a caption-style check computed from the template: font at least 56 px, plate opacity
at least 0.6 and contrast at least 4.5:1. A failure there or in any platform's file renders the slot
again with the next template, once, and then the slot fails and alerts.

**Frame check (`ugc` mode, `src/qa/vision.ts`, `prompts/vision.md`).** One model call (Haiku 5.5 at
low effort) looks at eight frames, 720×1280 and evenly spaced from 1 s in to 1 s before the end, and
at the product's reference photos and the owner's product note. It answers: product visible,
product matches (the references and the note together), a list of writing by kind, shop name
misspelled, generation fault. Code turns the answers into pass or fail. An overlay fails.
Prominent writing fails unless it is the shop's name. Background writing does not fail, except writing within edit distance 1 or 2 of the shop's name (compared without case, punctuation, spaces and a leading "the", for names of 4 or more letters): that is a misspelling and fails in any kind. It runs once
per new clip and not on a reused one. If the call itself fails, the paid clip is kept and the slot
waits (see "Retry").

Clipped or overlapping text and the overall look of an `ad` render are not checked by a model. That
is planned and not built.

FFmpeg here is the binary that ships with Remotion. It has no `blackdetect`, `freezedetect` or
`ebur128` filter, which is why those checks read raw frames and use `loudnorm`. The render step
normalizes loudness in up to three passes so a clip with one loud line reaches the target.

## Model use at runtime

Every call is `callJson` in `src/llm/client.ts`. Models come from `llm.models` in the config.

| Purpose | Where | Model (config key) | What it does |
|---|---|---|---|
| `ugc` | `creative/ugc.ts` | `claude-sonnet-5-5` (`script`) | Writes the concept for a clip (`ugc`) |
| `claims` | `creative/claims.ts` | `claude-haiku-5-5` (`copy`) | Judges whether each script chunk (`ad`), or the caption and spoken line (`ugc`), is supported by a fact |
| `copy` | `creative/copy.ts` | `claude-haiku-5-5` (`copy`) | Writes title, caption and hashtags for the four platforms |
| `copycheck` | `creative/copy.ts` | `claude-haiku-5-5` (`copy`) | Judges whether the copy's claims are supported |
| `vision` | `qa/vision.ts` | `claude-haiku-5-5` (`qa`) | Frame check on a generated clip (`ugc`) |
| `hooks` | `creative/hooks.ts` | `claude-sonnet-5-5` (`script`) | Refills the hook library (`ad`) |
| `script` | `creative/script.ts` | `claude-sonnet-5-5` (`script`) | Writes the four-beat script for a hook (`ad`) |

A call is refused (`LlmCapError`) when the month's spend plus the most the call can cost (every
output token and the prompt estimated at the cache-write price) would pass `llm.monthlyCapUsd`. A
`ugc` slot starts no new paid clip with less than $0.05 of that budget left, since the frame check
and the copy follow the clip; it reuses a stored clip instead.

## Operations

- **Daily summary.** After `ops.summaryAt`, once a day, retried every 15 minutes until delivered:
  yesterday's publications with links, today's slots (a held manual slot reads "waiting for approval"),
  a line for the posts waiting for approval, model and clip spend this month (and last
  month's on the 1st), publications needing attention, undelivered alerts and the backup line.
- **Second dead-man's switch.** `HEALTHCHECK_DAILY_URL` is pinged only after a summary was delivered
  to a real alert channel (with no channel nothing is pinged). The ping is recorded in `kv`
  `summary_ping` only when the response is ok, and is retried every 15 minutes until it is.
- **Disk alert.** `disk_full` when `DATA_DIR` or `OUT_DIR` is above `ops.diskAlertPercent` used.
- **Housekeeping.** Once a day. It deletes `attempt-<claim ms>` folders whose claim is older than
  `render.produceTimeoutMinutes` (a failed slot's for `ops.keepDays` more), the per-platform renders
  of a slot older than `ops.keepDays` whose publications are all `published` or `skipped`, and clips
  in `data/clips` older than `ops.keepDays` that no `ready` or `done` slot's master and no
  `succeeded` spend row of a `planned` or `producing` slot references. Referenced clips are never
  deleted, because `ugc` reuse needs them, except those of discarded or expired holds, which go
  after `keepDays`. It also runs `sweepMusic`, which removes stale uploads in `data/music/.incoming`,
  `*.part` files and `<sha>.m4a` files with no live track row. A failing entry is skipped, and any failure alerts
  `housekeeping_failed` once a day. Database rows are kept.
- **Backups.** Two halves. The pipeline writes a consistent snapshot to `data/backup/pipeline.db`
  and then `data/backup/ready` each night. The `backup` service (restic image, uid 1000, data
  volume read-only, secrets in `.env.backup`) backs up that file and `data/clips` to R2 whenever
  `ready` changes, prunes (7 daily, 4 weekly), writes `last-ok` to the `backup-status` volume and
  checks 5% of the data weekly. `data/music` is not backed up: the owner keeps the original files. Without `RESTIC_REPOSITORY` it idles. The snapshot includes tokens,
  so the restic password and keys must also be kept off the VM (D-14).
- **Deployment (not built).** Hosting, the VM setup and a 48-hour unattended run.

## Security

- `compose.yaml` publishes one port: the admin page, on the host's `127.0.0.1` only (see Admin).
  Every integration is an outbound call. The sign-in listener is bound to loopback and runs only
  during `auth higgsfield`. Unverified: the VM's firewall.
- The container runs as the non-root `node` user with all capabilities dropped,
  `no-new-privileges`, a process limit and a memory limit. Secrets are read from the environment
  and redacted in logs and alerts.
- Dependencies are pinned to exact versions with a lockfile. The base image and `uv` are pinned by
  digest.
- Code that sends a secret checks its destination first: the Higgsfield endpoints (authorization,
  token and registration URLs from the server's metadata) must be https on `higgsfield.ai`, the
  bridge's presigned upload and public URLs must be https, and downloaded clips and Shopify photos
  are accepted only from an https host on a fixed list. Requests that carry credentials (the
  bridge, the MCP server, the token endpoint, the Shopify Admin API) refuse redirects. Paths come
  only from slot ids and platform names and must stay inside `OUT_DIR`.
- The sign-in listener accepts only the request that carries the expected `state`.
- Error text stored in the `error` columns, alerts and logs passes through `scrub`, which removes
  bearer tokens, access and refresh tokens, JWTs, Shopify tokens, Telegram bot tokens, webhook
  URLs and the query string of any URL that carries a signature or token (`X-Amz-Signature`, `token=`).
- The CLI sets `umask 077`, and the database file and its `-wal` and `-shm` files are set to mode
  0600, because the database holds OAuth tokens.
- `--now` and `PIPELINE_NOW` are refused for `run` and `publish` unless `DRY_RUN=1`, because a
  false clock would defeat the 23-hour idempotency-key check.
- Third-party code is never piped from the network into a shell. Anything cloned goes to
  `third_party/` and runs in a container.
- Every phase ends with a security review by the Opus reviewer agent.
- Backups are to be encrypted before they leave the VM. Planned.

## Repository layout

```
src/                 one TypeScript package; each folder is a module
  cli.ts             run | plan | publish | produce | ingest | samples | doctor | health | auth | admin
  contracts.ts       shared schemas: brief, script, concept, edit list
  config/  db/       config loader and validation; SQLite and migrations
  shopify/           Admin API and public feed fetch, asset download, brief builder
  creative/  llm/    concept, hooks, script, claims, copy, assembly; Anthropic client and cost log
  tts/  music/       wrappers around the Python tools (ad mode); music/tracks.ts picks and sweeps owner tracks
  render/  qa/       producers (produce.ts, produce-ugc.ts), Remotion render; file checks, frame check
  router/            tier choice, spend ledger, MCP client, Higgsfield sign-in and provider
  publish/           the bridge publishers, the claim and retry logic
  scheduler/  ops/   tick loop, planner, time, holds.ts (manual slots); alerts and logging
  config/models.ts   custom video model rules, shared by the admin and the loader
  admin/             the admin page: server, auth, pages, posts, music, models, media (Phases 6b, 6c)
templates/           Remotion compositions (React): Ugc, Ad and three ad templates
prompts/             versioned prompt files, one per model purpose
tools/tts/           Kokoro CLI (Python, uv)
tools/music/         synthesized music bed (Python, uv)
config/              pipeline.config.ts, photo-tags.json, product-notes.json, brand/logo.png
compose.yaml         the deployment
infra/Dockerfile     the image
tests/               node --test
docs/                this folder
.claude/agents/  .github/workflows/  .mcp.json  CLAUDE.md
third_party/         vendored or cloned code, containerized
out/  data/          renders, database and data/music owner tracks (gitignored)
```

The modules are folders in a single package. There is one deployable and one owner, so separate
packages would add manifests and a build graph and enforce nothing the folder boundaries do not.
Splitting later is a mechanical move.

TypeScript runs directly on Node 24, which strips types natively, so there is no build step. Tests
use the built-in runner. HTTP uses built-in `fetch`. SQLite uses built-in `node:sqlite`. FFmpeg is
the binary Remotion ships.

## Build-time agents

Defined in `.claude/agents/` with the model in frontmatter.

| Agent | Model | Used for |
|---|---|---|
| `architect` | Opus | Architecture decisions, research synthesis, final review of each phase |
| `security-reviewer` | Opus | Security review of each phase |
| `implementer` | Sonnet | Modules, tests, Docker and infrastructure, integration |
| `scout` | Haiku | Reading docs, licence checks, configs, lint fixes, log triage |

The orchestrator plans, routes, reviews diffs and keeps `DECISIONS.md` current.

## Phases

`STATUS.md` says which phase is current.

| Phase | Exit criterion | How it is verified |
|---|---|---|
| 0 Research and plan | These documents | Reviewed against the brief |
| 1 Scaffold | `docker compose up` runs with stubs | Run it |
| 2 Ingest | Brief JSON for the live product | Inspect the JSON against the store |
| 3 Creative | Sample videos in `out/samples/` that pass the QA gate | QA gate on each; files sent to the owner |
| 4 Tiers | Router picks tiers by config and logs cost | Tests with a fake provider, then one real clip within budget |
| 5 Publishing | One private test post per connected platform | Post ids read back from the bridge |
| 6 Scheduler and ops | Two slots a day per platform, alerts, summary, cleanup | A compressed-time run in `DRY_RUN`, then one real day |
| 6b Admin | Via an SSH tunnel the owner logs in, changes a slot time, the clip preset and the `ugc` prompt, sees the new version in use within one tick and rolls one back; a guardrail-breaking edit is refused by the page and by the loader; port 8080 is unreachable from outside the VM | Tests, then the walk-through on the VM |
| 6c Posts on demand, music, models | In a throwaway compose project, through the browser: an mp3, an m4a, a wav and an mp4 upload and a renamed text file is refused; with two tracks ticked, Make a new post gives a held render that plays with Range 206, with music under the clip dipping in shot 1; Post publishes it with `dry_run = 1` on the next tick; a Discarded post is skipped and never reused; a double click makes one slot; a custom model with a forbidden option is refused by the page and the loader, a valid one is held on its test post and appears in Settings after Post; a ledger row records the live quote; the `ad-pipeline:local` image Id and the real project are unchanged. Then, after the 24-hour dry run, one real manual post with one paid clip | Tests, then the walk-through |
| 7 Deploy | 48 hours unattended | Logs and the publications table |
| 8 Feedback | Weekly ranking changes the sampler | Weights change after a metrics pull |

## Top risks

1. **Repetitive-content enforcement.** One product at two posts a day is close to what YouTube's
   spam policy describes. Variation and per-platform cadence reduce this. See `PLATFORMS.md`.
2. **One bridge carries every post.** If it is down, publications retry until `maxLateness` and are
   then skipped with an alert. If it loses a platform or changes its terms, the publisher is one
   file to replace (D-29).
3. **Higgsfield's MCP server is built for assistants.** Its tool names and result shapes can change
   without notice, and the provider fails closed and alerts. If the refresh token is refused the
   owner signs in again, and slots reuse stored clips until then (D-30).
4. **Generated video can be wrong.** The frame check catches a missing or different product, stray
   text and a misspelled shop name. A wrong spoken line is not checked at run time (D-28).
5. **Thin product data.** Few facts make for similar concepts. Adding heat settings, warm-up time,
   washing instructions and shipping time to the Shopify description helps every video.
6. **Supplier photos** may carry embedded text or watermarks. The owner's crop file routes around
   them.
7. **Sign-in expires.** `doctor` reports the Higgsfield sign-in state, and a signed-out slot reuses a
   stored clip and alerts. Signing in again is one command.
8. **Shopify's public JSON endpoint rate-limits.** Admin API credentials remove this, and the last
   good brief is reused on failure.
9. **Hosting prices and availability are moving.**
10. **English only.** If the store markets to Québec, French versions may be required.
