# uploader — spec (branch batch-actions)

Tiny unattended tool. Each posting slot: pick a random video from Google Drive, a random music track,
a caption (pinned or random), burn the caption onto the video, add the music, and post the result to
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
FONT_FILE (default /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf), DRY_RUN=1 (skip publish calls and claim writes only).

## Drive layout (created by `uploader init`)
Root folder (DRIVE_ROOT_ID, made by the owner). `init` creates inside it, once, and prints their IDs:
- folder `videos`, folder `music`
- Google Doc `settings`, Google Doc `captions` (pre-filled with defaults/examples)
- file `state.json` (`{"claims":{}}`)
`init` is idempotent: it finds existing items by name (`'ROOT' in parents and name='x' and trashed=false`)
and creates only what's missing. It refuses if there are duplicates of a name.
`tick` never creates any of these; it finds them by name and fails if a name is missing or duplicated.
OAuth scopes: `https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/youtube.upload`.
Docs are read with `files/{id}/export?mimeType=text/plain`; strip a UTF-8 BOM and `\r`.
Listing: `pageSize=1000`, follow `nextPageToken`, `trashed=false`, videos `mimeType contains 'video/'`,
music `mimeType contains 'audio/'`. Download `files/{id}?alt=media` streamed to disk.

## settings doc (key = value, `#` comments, blank lines ignored)
    times = 09:00, 18:00        # each entry is one post; list a time twice for two posts. Required.
    timezone = America/Toronto  # Required.
    platforms = youtube, instagram, facebook, tiktok
    caption =                   # pinned caption; empty means random line from the captions doc
    hashtags = #shorts #fyp     # appended to post text only; never burned on video
    burn_caption = yes
    music_volume = 0.25         # 0..1, only used for _keepaudio videos
    youtube_privacy = public    # public | unlisted | private
    paused = no
Any parse error, unknown key, bad time, bad timezone or unknown platform: the tick logs the error,
posts nothing and exits non-zero. Never fall back to defaults.

## captions doc
One caption per line. `#` lines and blank lines ignored. A literal `\n` inside a line means a line break.

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
1. Pick random video (files whose name contains `_keepaudio` mix audio), random music, caption.
2. Download both to a temp dir (removed afterwards, also on error).
3. ffprobe the video: duration, has-audio. Skip (log, pick another, up to 5 tries) if duration < 3 s.
4. ffmpeg once:
   - `-stream_loop -1` on the music input, `-t min(duration, 90)`, `-shortest`.
   - video: scale to fit 1080x1920 and pad (black), `setsar=1`, fps unchanged.
   - drawtext when burn_caption: `fontfile=FONT_FILE`, `textfile=<tmp file>`, `expansion=none`,
     white text, black border, `fontsize=56`, `y=(h-text_h)*0.7`, centred. Caption wrapped in Go to <=24 chars per line and at most 5 lines (extra lines dropped, "…" added),
     emoji and other non-BMP / symbol runes stripped from the burned text only. Escape `\` and `:` in the textfile
     and fontfile paths; a path containing `'` is refused before ffmpeg runs.
   - audio: replace => music only (`anull`); keepaudio and source has audio =>
     `amix=inputs=2:duration=first:normalize=0` with music at `music_volume`; keepaudio but no audio
     stream => replace.
   - `-c:v libx264 -preset veryfast -crf 23 -rc-lookahead 10 -threads 2 -pix_fmt yuv420p
      -c:a aac -b:a 128k -fpsmax 60 -movflags +faststart`.
   - Build the ffmpeg args in a pure function (unit-tested); run with exec.CommandContext.
5. Post text = caption + "\n\n" + hashtags. YouTube title = caption (first line) + hashtags, `<` `>`
   stripped, cut to 100 runes. The YouTube description also has `<` `>` stripped. IG caption cut to 2200 runes and at most 30 hashtags.
6. Publish to each enabled platform in sequence. One failing does not stop the others.
   Each platform has a 12 min timeout. Never retry a publish request after it has been sent. Log `{"slot","platform","id"}` on success.
7. Exit code: 0 if everything due succeeded or nothing was due; 1 if any slot or platform failed.

## Commands
- `uploader init` — create the Drive layout (see above).
- `uploader due` — exit 0 and print `due` if a slot is due now, else print `idle` and exit 0 with
  output `idle`. (Used by the workflow to skip installing ffmpeg.) Reads settings + state only.
- `uploader tick` — run all due slots.
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
- YouTube: resumable upload `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
  with JSON snippet{title, description=Text, categoryId "22"}, status{privacyStatus, selfDeclaredMadeForKids:false};
  then PUT the file to the Location URL. Return video id.
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
- TikTok via Zernio (base `https://zernio.com/api/v1`, `Authorization: Bearer <key>`; reference
  implementation: /home/haashir/cs_projects/automated_upload_pipeline/src/publish/bridge.ts):
  GET /accounts → the active tiktok account; GET /accounts/{id}/tiktok/creator-info?mediaType=video →
  privacy must offer PUBLIC_TO_EVERYONE else fail; POST /media/presign {filename, contentType:"video/mp4", size}
  → PUT file to uploadUrl (no Authorization header) → POST /posts with `Idempotency-Key: <slot id>-tiktok`,
  {content: Text, publishNow: true, platforms:[{platform:"tiktok", accountId}], mediaItems:[{type:"video", url: publicUrl}],
  tiktokSettings:{privacy_level, allow_comment, allow_duet, allow_stitch (from creator-info interactionSettings, default true),
  content_preview_confirmed:true, express_consent_given:true, video_made_with_ai:false, commercialContentType:"brand_organic"}}.
  409 with details.existingPostId => treat as that post. Then poll GET /posts/{id} every 10 s up to 5 min until
  status published (failed => error, still publishing at timeout => log warning, return id).
