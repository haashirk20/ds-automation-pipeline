# uploader

## 1. What it does

Every hour GitHub runs this tool. If a posting time has arrived, it picks a random video and a random
music track from your Google Drive, burns a caption onto the video, and posts it to YouTube Shorts,
Instagram Reels, Facebook Page Reels and TikTok. You only add files to Drive and edit two Google Docs.

Cost: $0.

- GitHub Actions: a private repo gets 2000 free minutes a month. The hourly check uses about 720.
  Each run that posts uses about 3 to 5 more.
- Zernio: free for up to 2 connected accounts. Only TikTok connects there.
- YouTube, Facebook and Instagram use their official APIs. These are free.

## 2. Setup (once)

### a. Google Cloud (YouTube and Drive)

1. Go to https://console.cloud.google.com and create a project.
2. Enable two APIs: Google Drive API and YouTube Data API v3.
3. Open the OAuth consent screen. Choose user type External. Add your own Google account as a user.
4. Publish the app: set the status to "In production". Do not leave it in "Testing". In Testing, Google
   says the app "is issued a refresh token expiring in 7 days", and posting would stop after a week.
5. Google will show "Google hasn't verified this app". This is expected for your own app.
   Click Advanced, then continue.
6. Create credentials: OAuth client ID, application type "Desktop app". Copy the client ID and secret.
7. On your computer, in this folder (needs Go installed):

```
go build -o uploader .
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
   The next run then fails and GitHub emails you. Repeat step 3 and update the secret.

### d. Zernio (TikTok)

1. Sign up at https://zernio.com.
2. Connect your TikTok account. Connect only TikTok.
3. Create an API key. This is `ZERNIO_API_KEY`.

### e. GitHub

1. Put this code in a private GitHub repo.
2. In the repo go to Settings, Secrets and variables, Actions, and add these repository secrets. The
   names must match exactly:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
DRIVE_ROOT_ID
META_PAGE_ID
META_PAGE_TOKEN
META_IG_USER_ID
ZERNIO_API_KEY
```

3. Important: GitHub runs scheduled workflows only from the repo's default branch. This code is on the
   branch `batch-actions`. Either set `batch-actions` as the default branch (Settings, Branches), or put
   this branch's code in a separate repo.
4. If you turn off a platform in `settings`, its secrets are not needed. If a platform is on and its secrets
   are missing, the run fails before it posts anything.

### f. Test

1. Go to the Actions tab, pick the `post` workflow, click Run workflow, and tick **dry_run**.
2. A dry run skips the publish calls and does not claim slots. It still downloads and renders the video.
   Scheduled runs are never dry runs.
3. A run only does work when a slot is due. To see it work, set a time in `settings` that is within
   the last hour, then run the workflow and read the log. You should see `dry run, publish skipped`.
4. You can also dry run on your computer: set all the variables and run `DRY_RUN=1 ./uploader tick`.
   This needs `ffmpeg` and `ffprobe` installed.

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
- The check runs hourly, so a post can be up to about 1 hour late. A post more than 3 hours late is
  skipped and never made up.
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

- When a run fails, GitHub emails you.
- Open the Actions tab, click the failed run, open the log. Each event is one JSON line. The line with
  `"level":"ERROR"` says what failed.
- One platform failing does not stop the others. The run still ends as failed.
- A slot that failed after it was claimed is not retried. This is on purpose: the tool must never post
  the same video twice. You simply miss that slot. If the failure came before the claim (for example while
  downloading or rendering), the next run tries again while the slot is within 3 hours.
- Do not edit or delete `state.json` to "retry" a slot. That can cause a double post.
- Run `./uploader due` on your computer to see whether a slot is due. It prints `due` or `idle`.

## 6. Risks

- Music from your Drive may get the video muted on TikTok business accounts (TikTok limits business
  accounts to its commercial music library), or claimed by Content ID on YouTube. Use music you own or
  that is cleared for use.
- Daily limits: YouTube allows about 100 uploads a day on the default quota. Facebook allows 30 Reels a
  day. Instagram allows about 50 posts a day. Normal use is far below these.
- Tokens: the Meta token can die (see 2c). The Google refresh token dies if the app goes back to
  Testing or if you revoke access.
