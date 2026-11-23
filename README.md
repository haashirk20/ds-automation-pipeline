# uploader

## 1. What it does

A small service on an Oracle Cloud VM. When a posting time arrives, it picks a random video and a random
music track from your Google Drive, burns a caption onto the video, and posts it to YouTube Shorts,
Instagram Reels, Facebook Page Reels and TikTok. You add files to Drive, edit two Google Docs, or use
the admin page (settings, captions, upload, Post now).

**WARNING: never run the GitHub Actions workflow (branch `batch-actions`) and this VM on the same Drive
folder.** They would both post the same slots.

Cost: $0 on Oracle Always Free. Zernio is free for up to 2 connected accounts (YouTube and TikTok connect there).
Facebook and Instagram use their official APIs, which are free.

## 2. Setup (once)

### a. Google Cloud (Drive)

1. Go to https://console.cloud.google.com and create a project.
2. Enable one API: Google Drive API. You do not need the YouTube Data API.
3. Open the OAuth consent screen. Choose user type External. Add your own Google account as a user.
4. Publish the app: set the status to "In production". Do not leave it in "Testing". In Testing, Google
   says the app "is issued a refresh token expiring in 7 days", and posting would stop after a week.
5. Google will show "Google hasn't verified this app". This is expected for your own app.
   Click Advanced, then continue.
6. Create credentials: OAuth client ID, application type "Desktop app". Copy the client ID and secret.
7. On your computer, in this folder (needs Go installed):

```
go build -o uploader .   # on your computer, for these two commands
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
./uploader auth-google
```

8. It prints a link. Open it, sign in, allow access. The terminal then prints a refresh token.
   Copy it. This is `GOOGLE_REFRESH_TOKEN`. Treat it like a password.

### b. Google Drive

1. In Drive, create one empty folder. Open it. The address looks like
   `https://drive.google.com/drive/folders/1AbC...`. The text after `folders/` is the folder ID.
2. Run:

```
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export GOOGLE_REFRESH_TOKEN=...
export DRIVE_ROOT_ID=<the folder ID>
./uploader init
```

`init` creates these inside your folder and prints their IDs. It is safe to run again. It only adds
what is missing.

- `videos/` folder. Put your videos here.
- `music/` folder. Put your audio tracks here.
- `settings` Google Doc. See section 3.
- `captions` Google Doc. One caption per line.
- `state.json` file. The tool uses it to remember which slots it already posted. Do not edit it.
  Do not delete it.

Do not rename or duplicate these items. The tool finds them by name and fails if one is missing or
doubled.

By default a video's own sound is removed and replaced by the music. To keep the original sound
quietly under the music, put `_keepaudio` in the file name, for example `shop_tour_keepaudio.mp4`.
The music volume is then set by `music_volume` in settings.

### c. Meta (Facebook and Instagram)

Verify in Meta's UI. Menus change often.

1. You need a Facebook Page and an Instagram professional account (business or creator) linked to that Page.
2. Go to https://developers.facebook.com and create an app of type Business. Make sure you are an admin of it.
3. Get a long-lived Page access token with these permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`, `business_management`.
   A common way: in Graph API Explorer, pick your app, request those permissions, generate a user token,
   exchange it for a long-lived user token, then call `GET /me/accounts`. The `access_token` shown for your
   Page is the long-lived Page token. This is `META_PAGE_TOKEN`.
4. `META_PAGE_ID` is the `id` of your Page in the `GET /me/accounts` result.
5. `META_IG_USER_ID`: call `GET /{page-id}?fields=instagram_business_account`. The `id` inside
   `instagram_business_account` is the value.
6. The token stops working if you change your Facebook password or remove the app from your account.
   The next post then fails (see the logs). Repeat step 3 and update `META_PAGE_TOKEN` in `/etc/uploader.env`.

### d. Zernio (YouTube and TikTok)

1. Sign up at https://zernio.com.
2. Connect your YouTube channel and your TikTok account. These are your 2 free accounts. Connect no others.
3. Create an API key. This is `ZERNIO_API_KEY`.

### e. Oracle VM

1. Create an Always Free VM with Ubuntu 24.04. Prefer `VM.Standard.A1.Flex` with 1 OCPU and 6 GB.
   `VM.Standard.E2.1.Micro` works but renders slowly.
2. Upgrade the account to Pay-As-You-Go. Oracle can reclaim idle Always Free VMs; an upgraded account
   keeps them, and the free resources stay free.
3. Build on your computer (needs Go). Use `arm64` for A1, `amd64` for E2:

```
GOOS=linux GOARCH=arm64 go build -trimpath -ldflags=-s -o uploader .
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags=-s -o uploader .
```

4. Copy the binary and the `deploy/` folder, then run the setup:

```
scp -r uploader deploy user@vm:
ssh user@vm
sudo deploy/setup.sh
```

   Run it from the folder that holds `uploader` and `deploy/`. It installs ffmpeg and a font, creates the
   `uploader` user and a 2 GB swapfile if there is none, and installs the systemd unit.
5. The first run creates `/etc/uploader.env` from `deploy/uploader.env.example` and stops. Fill in every
   value you have (section 2a to 2d) and set `ADMIN_PASSWORD` (12 or more characters). Then run
   `sudo deploy/setup.sh` again. It starts the service.
6. Dry run: add `DRY_RUN=1` to `/etc/uploader.env` and run `sudo systemctl restart uploader`. It skips the
   publish calls and the claims but still downloads and renders. Remove the line when done.

### f. Admin page

The page listens only on `127.0.0.1` of the VM. Open an SSH tunnel and use a browser on your computer:

```
ssh -L 8080:127.0.0.1:8080 user@vm
```

Then open http://127.0.0.1:8080 and sign in with any user name and `ADMIN_PASSWORD`. The local port must
equal the port in `ADMIN_ADDR` (default `127.0.0.1:8080`), or the page refuses the request.

- Status: today's slots, videos per day, counts of videos, music and captions, the last run and its error,
  recent claims, and a **Post now** button. Post now posts one extra video right away. It is claimed like
  any slot, so it never posts twice.
- Settings: edits the `settings` doc. The text is checked first; invalid text is not saved.
- Captions: edits the `captions` doc, or adds one line.
- Upload: sends a video or a music file straight to Drive (limit `ADMIN_MAX_UPLOAD_MB`, default 500).

Logs: `journalctl -u uploader`. Each event is one JSON line.

## 3. Settings reference

Edit the `settings` Google Doc. One `key = value` per line. Lines starting with `#` and blank lines are
ignored.

```
times = 09:00, 18:00        # each entry is one post; list a time twice for two posts. Required.
timezone = America/Toronto  # Required.
platforms = youtube, instagram, facebook, tiktok
caption =                   # pinned caption; empty means random line from the captions doc
hashtags = #shorts #fyp     # appended to post text only; never burned on video
burn_caption = yes
music_volume = 0.25         # 0..1, only used for _keepaudio videos
youtube_privacy = public    # public | unlisted | private
paused = no
```

- `times`: each entry is one post. The number of entries is the number of videos per day. Use 24-hour
  `HH:MM` in the `timezone` you set. To post twice at 09:00, write `09:00, 09:00`.
- The service checks every minute. A post more than 3 hours late is skipped and never made up.
- `caption`: the pinned caption. If it has text, every post uses it. If it is empty, each post uses a
  random line from the `captions` doc.
- `paused = yes`: nothing is posted until you set it back to `no`.
- If any line is wrong (unknown key, bad time, bad timezone, unknown platform), the run posts nothing and
  fails. There are no silent defaults. Fix the doc and the next run works.

## 4. Adding content

- Videos: upload to the `videos/` folder in Drive. The Drive phone app works. Videos shorter than 3
  seconds are skipped.
- Music: upload to the `music/` folder.
- Captions: add a line to the `captions` doc. A literal `\n` inside a line makes a line break. Lines
  starting with `#` are ignored.

## 5. Troubleshooting

- `journalctl -u uploader -f` shows the logs. The line with `"level":"ERROR"` says what failed. The admin
  Status page shows the last error.
- One platform failing does not stop the others.
- A slot that failed after it was claimed is not retried. This is on purpose: the tool must never post
  the same video twice. You miss that slot. If the failure came before the claim (for example while
  downloading or rendering), the slot is tried again after 20 minutes while it is within 3 hours.
- Do not edit or delete `state.json` to "retry" a slot. That can cause a double post.
- `uploader: another uploader process is already running`: only one process may run at a time. Stop the
  service before running `uploader tick` by hand.

## 6. Risks

- Music from your Drive may get the video muted on TikTok business accounts (TikTok limits business
  accounts to its commercial music library), or claimed by Content ID on YouTube. Use music you own or
  that is cleared for use.
- Daily limits: Zernio posts are unlimited, but YouTube's own daily upload limits still apply. Facebook allows 30 Reels a
  day. Instagram allows about 50 posts a day. Normal use is far below these.
- Tokens: the Meta token can die (see 2c). The Google refresh token dies if the app goes back to
  Testing or if you revoke access.
