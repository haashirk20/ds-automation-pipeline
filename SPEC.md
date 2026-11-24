# uploader — spec (branch batch-actions)

Tiny unattended tool. Each posting slot: pick a random video from Google Drive, a random music track,
on-video text (pinned or random), burn it onto the video, add the music, and post the result to
YouTube Shorts, Instagram Reels, Facebook Page Reels and TikTok. Runs from GitHub Actions hourly.

Priorities, in order: never double-post; lowest memory and money; least code.

## Hard rules
- Go, standard library only. No third-party modules. `go.mod` module `uploader`, one package `main`.
- Only `main.go` reads the clock (`time.Now()`); everything else takes `now time.Time`.
- `import _ "time/tzdata"` in main.go (static binary may have no zoneinfo).
- Secrets come from environment variables only and are never logged, not even in error text.
  Errors carry method, host+path (no query string) and HTTP status plus the API's own error message.
- Logs: one JSON object per line on stdout via `log/slog` JSON handler.
- Stream files: never read a whole video into memory. Use `*os.File` bodies with `ContentLength`.
- Every HTTP request has a context with a timeout. Redirects are not followed for requests that carry a token.
- Tests: `go test ./...`, using `net/http/httptest` fakes. No real network in tests.

## Environment variables
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, DRIVE_ROOT_ID,
META_PAGE_ID, META_PAGE_TOKEN, META_IG_USER_ID, ZERNIO_API_KEY,
FONT_FAMILY (pango font family, default "Montserrat SemiBold"), DRY_RUN=1 (skip publish calls and claim writes only).

## Drive layout (created by `uploader init`)
Root folder (DRIVE_ROOT_ID, made by the owner). `init` creates inside it, once, and prints their IDs:
- folder `videos`, folder `music`
- Google Doc `settings`, Google Doc `captions`, Google Doc `products` (pre-filled with defaults/examples)
- file `state.json` (`{"claims":{}}`)
`init` is idempotent: it finds existing items by name (`'ROOT' in parents and name='x' and trashed=false`)
and creates only what's missing. It refuses if there are duplicates of a name.
`tick` never creates any of these; it finds them by name and fails if a name is missing or duplicated.
OAuth scopes: `https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file`. Google is used for Drive only; YouTube posts through Zernio.
Docs are read with `files/{id}/export?mimeType=text/plain`; strip a UTF-8 BOM and `\r`.
Products are subfolders of `videos/` (name matched exactly after trimming spaces). Loose videos directly in `videos/`
are one extra product "". `tick` fails (error mentions running init) if `products` is absent or duplicated.
Product folders and their videos, and music, are listed once per tick and shared by every slot.
Listing: `pageSize=1000`, follow `nextPageToken`, `trashed=false`, videos `mimeType contains 'video/'`,
music `mimeType contains 'audio/'`, subfolders `mimeType = 'application/vnd.google-apps.folder'`. Download `files/{id}?alt=media` streamed to disk.

## settings doc (key = value, `#` comments, blank lines ignored)
    times = 09:00, 18:00        # each entry is one post; list a time twice for two posts. Required.
    timezone = America/Toronto  # Required.
    platforms = youtube, instagram, facebook, tiktok
    burn_text =                 # on-video text for a product with no lines in the captions doc
    default_caption =           # post text for a video with no product entry (may be empty; logs a warning)
    hashtags = #shorts #fyp     # appended to post text only; never burned on video
    burn_caption = yes
    music_volume = 0.25         # 0..1, music under the video's own sound
    youtube_privacy = public    # public | unlisted | private
    paused = no
Any parse error, unknown key, bad time, bad timezone or unknown platform: the tick logs the error,
posts nothing and exits non-zero. Never fall back to defaults.
The old key `caption` is an error: "caption was split: use burn_text for on-video text; post captions now live in the products doc".

## captions doc (on-video text)
`[Product]` sections like the products doc (same header, duplicate and comment rules; text before the
first header is ignored with a warning). Each line of a section is one burn option, e.g.
`comment BOOK if you want one! 📖✨`; a random line of the video's product is burned. A product with no
lines uses `burn_text`; if that is empty too, the slot fails before its claim. Read once per tick, only
when burn_caption. A literal `\n` inside a line means a line break. Emoji render in colour.

## products doc (post text)
    # a comment is a lone "#" or "# " plus text; "#tarot" and "#1 seller" are kept
    [Velvet Tarot Deck]
    Hand-gilded tarot deck ✨ Link in bio #tarot
The caption runs until the next `[header]` or the end; blank edges are trimmed. Header = folder name in `videos/`.
A `[Name]` line is a header only if Name is a product folder; otherwise it is caption text and a warning is logged
(`[x] does not match a product folder`). A duplicate header is a parse error: the tick fails before any claim.
The `captions` doc uses the same comment rule.
No entry (or loose video): `default_caption`, with a warning naming the product.

## Slots and state (at-most-once)
- Slot ID = local `YYYY-MM-DD HH:MM#k` where k is the 1-based occurrence index of that time in `times`.
- A slot is due when slot time <= now, now - slot time <= 3h, and its ID is not in `state.claims`.
  Consider today and yesterday (local) so a late run near midnight works.
- For each due slot, in order: first pick, download and render (a failure here writes no claim and the slot
  is retried on the next run while inside its 3h window), then write the claim (`claims[id] = now RFC3339`) to state.json with
  `files.update` (upload media to the existing ID) BEFORE any publish request. DRY_RUN=1 writes no claim (logs "dry run: claim skipped"). Before any claim, every enabled platform must have its credentials, else the tick fails. A failed claim write
  aborts the whole tick with non-zero exit. Prune claims older than 2 days on each write.
- A crash after claiming means a missed slot, never a double post. Nothing re-posts a claimed slot.
- `paused = yes`: nothing is due.

## Per slot pipeline
1. Pick a random product, then a random video of it, random music.
   A product counts once however many videos it has. Retry (below) picks a new product and video.
2. Download both to a temp dir (removed afterwards, also on error).
3. ffprobe the video: duration, has-audio. Skip (log, pick another, up to 5 tries) if duration < 3 s.
4. ffmpeg twice. Args for both tools are built in pure, unit-tested functions; run with exec.CommandContext.
   - Pass 1 (`nomusic.mp4`, the file YouTube gets): video scaled to fit 1080x1920 and padded (black), `setsar=1`,
     `-t min(duration, 90)`, the video's own sound (aac 128k) or `-an` when it has none.
     `-c:v libx264 -preset veryfast -crf 23 -rc-lookahead 10 -threads 2 -pix_fmt yuv420p -fpsmax 60 -movflags +faststart`.
   - burn text when burn_caption, TikTok caption style: `pango-view` draws the text to a transparent PNG (white,
     `FONT_FAMILY` 64 px, 960 px wide, word-wrapped, centred; emoji come from fonts-noto-color-emoji by fontconfig
     fallback). Control characters except `\n` are removed and the text is limited to 6 lines and 150 runes (cut at the
     last space). ffmpeg takes the PNG as input 1 and overlays it centred at `y=200`, over a black outline made from
     the PNG's alpha grown by 4 `dilation` passes. Without burn there is no second input.
   - Pass 2 (`out.mp4`, every other platform): `-c:v copy` of pass 1 plus the music (`-stream_loop -1`, `-t`, `-shortest`,
     so it is looped or cut to the video's length). Source has audio => `amix=inputs=2:duration=first:normalize=0`,
     video sound at full volume, music at `music_volume`; no audio stream => music only (`anull`). aac 128k, `+faststart`.
5. Post text = product caption + "\n\n" + hashtags. YouTube title = product caption (first line; if empty, the product name, else "New video") + hashtags, `<` `>`
   stripped, cut to 100 runes. The YouTube description also has `<` `>` stripped. IG caption cut to 2200 runes and at most 30 hashtags.
6. Publish to each enabled platform in sequence. One failing does not stop the others.
   Each platform has a 12 min timeout. Never retry a publish request after it has been sent. Log `{"slot","platform","id"}` on success.
7. Exit code: 0 if everything due succeeded or nothing was due; 1 if any slot or platform failed.

## Commands
- `uploader init` — create the Drive layout (see above).
- `uploader due` — exit 0 and print `due` if a slot is due now, else print `idle` and exit 0 with
  output `idle`. (Used by the workflow to skip installing ffmpeg.) Reads settings + state only.
- `uploader tick` — run all due slots. With `POST_NOW=<id>` (the workflow sets the run ID when the
  `post_now` input is ticked) it also runs one extra slot `manual <id>`, ignoring `times` and `paused`;
  it is claimed like any slot, and an already-claimed manual ID is an error.
- `uploader auth-google` — one-time helper: prints the consent URL (access_type=offline,
  prompt=consent, loopback redirect `http://127.0.0.1:<port>/`), listens once on 127.0.0.1,
  exchanges the code, prints the refresh token to stdout for the owner to copy. Only command that
  prints a secret, and only because the owner asked for it.

## Publisher interface (shared by all publisher files)
    type Post struct {
        File    string // path to the final mp4
        Text    string // post text (caption + hashtags)
        Title   string // YouTube title, already cut
        SlotID  string
        Privacy string // youtube_privacy
    }
    type Publisher interface {
        Name() string // "youtube" | "instagram" | "facebook" | "tiktok"
        Publish(ctx context.Context, p Post) (id string, err error)
    }
Google access tokens come from `func (g *googleAuth) Token(ctx context.Context) (string, error)`
(google.go), which refreshes via POST https://oauth2.googleapis.com/token
(client_id, client_secret, refresh_token, grant_type=refresh_token) and caches until expiry-60s.

## Publishers
- Facebook Page Reels (Graph API version: one constant `graphVersion = "v26.0"`; v26.0 is the newest seen on the versions page snippet 2026-11-22, unverified):
  `POST https://graph.facebook.com/{ver}/{page}/video_reels` upload_phase=start → video_id, upload_url;
  `POST https://rupload.facebook.com/video-upload/{ver}/{video_id}` headers `Authorization: OAuth <token>`,
  `offset: 0`, `file_size: <bytes>`, body = file; then `POST .../{page}/video_reels`
  upload_phase=finish, video_id, video_state=PUBLISHED, description=Text. Return video_id.
- Instagram Reels: `POST https://graph.facebook.com/{ver}/{ig}/media` media_type=REELS, upload_type=resumable,
  caption, share_to_feed=true → container id + uri; `POST https://rupload.facebook.com/ig-api-upload/{ver}/{container}`
  headers `Authorization: OAuth <token>`, `offset: 0`, `file_size`; poll `GET /{container}?fields=status_code`
  every 10 s up to 10 min until FINISHED (ERROR/EXPIRED => fail); `POST /{ig}/media_publish` creation_id. Return media id.
  Uses the Page token (Facebook Login for Business).
- YouTube gets `Post.NoMusicFile` (pass 1) as its File; the others get pass 2.
- YouTube and TikTok via one shared Zernio client (publish_zernio.go). The presign+PUT happens once per file
  (publicUrl cached for the current slot and file only); the account list is fetched once per slot. Each platform is its own POST /posts with
  `Idempotency-Key: <slot id>-<platform>`. YouTube entry: platforms:[{platform:"youtube", accountId,
  platformSpecificData:{title: Title, visibility: Privacy, madeForKids:false}}], content = Text with `<` `>` stripped.
- TikTok via Zernio (base `https://zernio.com/api/v1`, `Authorization: Bearer <key>`; reference
  implementation: /home/haashir/cs_projects/automated_upload_pipeline/src/publish/bridge.ts):
  GET /accounts → the active tiktok account; GET /accounts/{id}/tiktok/creator-info?mediaType=video →
  privacy must offer PUBLIC_TO_EVERYONE else fail; media from the shared slot upload (POST /media/presign, then PUT
  to uploadUrl with no Authorization header) → POST /posts with `Idempotency-Key: <slot id>-tiktok`,
  {content: Text, publishNow: true, platforms:[{platform:"tiktok", accountId}], mediaItems:[{type:"video", url: publicUrl}],
  tiktokSettings:{privacy_level, allow_comment, allow_duet, allow_stitch (from creator-info interactionSettings, default true),
  content_preview_confirmed:true, express_consent_given:true, video_made_with_ai:false, commercialContentType:"brand_organic"}}.
  409 with details.existingPostId => treat as that post. Then poll GET /posts/{id} every 10 s up to 5 min until
  status published (failed => error, still publishing at timeout => log warning, return id).
