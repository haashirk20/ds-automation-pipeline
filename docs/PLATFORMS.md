# Platform realities

Researched 2026-11-11 from official documentation, by research agents that quoted their sources.
The orchestrator re-checked the YouTube revision-history entry and the bridge prices first-hand.
Everything else is as reported, and each publisher confirms its own facts with a real API call in
Phase 5. Items marked **(unverified)** come from vendor pages, press or community reports. Three
facts on this page changed in the last 12 months, so re-check anything here before relying on it later.

## Summary

| Platform | Private test (Phase 5 exit) | Public, unattended posting | Blocking step | Lead time |
|---|---|---|---|---|
| YouTube Shorts | Same day, `privacyStatus: "unlisted"` | Same day | Publish the OAuth consent screen to "In production" | minutes |
| Facebook Page Reels | Same day: app in Development mode, visible to app roles only | Switch app to Live, Standard Access | None expected. Fallback: App Review + Business Verification | minutes (weeks if fallback) |
| TikTok | Same day through a Sandbox app: `SELF_ONLY`, account set to private | **Not possible with our own app.** TikTok's audit excludes internal tools. Needs a hosted bridge with an audited app | Pick a bridge and create the account | same day |
| Instagram Reels | Same day: upload and process, stop before publishing | Same day: set `visibility` to `public` | None expected: same Meta app and token as Facebook. Fallback: App Review | minutes |

The three findings that decide feasibility:

1. **TikTok will not audit this tool.** Public posting through our own TikTok app is off the table.
2. **YouTube removed the private lock on 2026-11-02.** No audit is needed for public uploads.
3. **Facebook and Instagram share one Meta app and one token**, so the fourth platform adds no new
   approval step.

---

## TikTok — Content Posting API

**Flow (Direct Post).** `POST /v2/post/publish/creator_info/query/` → `POST /v2/post/publish/video/init/`
with `source: FILE_UPLOAD` → `PUT` chunks (5–64 MB, last chunk up to 128 MB) → poll
`/v2/post/publish/status/fetch/` with the `publish_id`.
[Direct Post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post),
[media transfer guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)

**Unaudited clients.** "Unaudited API Clients can only post contents in SELF_ONLY viewership." and
"All user accounts using the API client to post must be set to private at the time of posting."
Up to 5 users per 24 hours.
[Content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)

**Audit eligibility.** Same page: "API Clients must not be limited to test applications and should
be intended for a wide audience, not limited to internal groups/private use." and "Not acceptable:
A utility tool to help upload contents to the account(s) you or your team manages." That sentence
describes this project. We do not apply for the audit under a different description.

**Draft route.** `POST /v2/post/publish/inbox/video/init/` with the `video.upload` scope sends the
video to the account's TikTok inbox. A person must open the notification and finish the post in
the app. Not unattended.
[Upload content](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content)

**Options for public posting**

| Option | Public? | Unattended? | Cost | Verdict |
|---|---|---|---|---|
| A. Hosted bridge with an audited TikTok app | Yes (vendor claim) | Yes | $0–24/mo | **Recommended** |
| B. Own app, Direct Post, unaudited | No, `SELF_ONLY` only | Yes | $0 | Test path only (Phase 5 exit) |
| C. Own app, inbox drafts | Yes, after a manual tap per post | No | $0 | Fallback if no bridge is wanted |
| D. Higgsfield MCP `tiktok_publish` | Direct post or drafts (vendor claim) | No, MCP is interactive | credits | Not a runtime path |

Bridge shortlist. All rows are vendor claims and get verified with one real post before we commit:

| Bridge | Price | Monthly post cap | Notes |
|---|---|---|---|
| [Zernio](https://zernio.com/pricing) (formerly Late) | First 2 connected accounts free, then $6 per account | "Unlimited posts" | API-first. Cheapest. One account for TikTok is $0 |
| [Upload-Post](https://www.upload-post.com/pricing) | $16/mo billed yearly, $24 monthly, 5 profiles | "Unlimited uploads" | Free plan is 10 uploads/mo. Claims an audited TikTok app |
| Post for Me | $10/mo | 1,000 posts | Rejected: capped |
| Blotato | $29/mo | 900 TikTok posts | Rejected: capped |
| Postiz Cloud | $29/mo | Unlimited | TikTok audit status not confirmed |
| Ayrshare | $149/mo | Unlimited | Rejected: cost |

Selection criteria at integration time: public posting confirmed by a real post, no monthly cap,
passes `is_aigc` and the brand toggle through, accepts a file upload, has a status endpoint, and
accepts an idempotency key or a reference we can search for afterwards.

**Limits.** 6 requests per minute per user token. About 15 posts per creator per day, shared across
all API clients including bridges. Video: MP4/WebM/MOV, H.264/H.265, 23–60 fps, 360–4096 px per
side, up to 4 GB and 10 minutes.

**Tokens (own app).** Access token 2 hours, refresh token 180 days. Refresh tokens rotate, and
reusing a replaced one forces the user to authorize again. The figures 24 h and 365 d seen in older
guides are stale.
[Token management](https://developers.tiktok.com/doc/oauth-user-access-token-management).
Desktop Login Kit allows `http://localhost:<port>` redirects with PKCE. TikTok's desktop PKCE uses
the hex SHA-256 digest, not base64url (see the sibling project `../social_media_posting_mcp/server.py`).

**Sandbox.** A Sandbox app with the TikTok account added as a target user works without app review
and is how the private test post is made.

**AI disclosure.** `post_info.is_aigc: true` adds the "Creator labeled as AI-generated" tag. Policy:
TikTok requires a label on "AI-generated or significantly edited content that shows
realistic-looking scenes or people."
[Community guidelines](https://www.tiktok.com/community-guidelines/en/integrity-authenticity)

**Commercial content.** `brand_organic_toggle: true` marks own-brand promotion ("Promotional
content" label). Branded content cannot be private, so the `SELF_ONLY` test post leaves
`brand_content_toggle` off.

**Music.** Business use is limited to TikTok's Commercial Music Library or audio we hold rights to
(unverified against TikTok's own page). The pipeline only ships audio it owns or CC0 tracks.

**Canada.** No developer or API restriction found.

---

## YouTube — Data API v3

**Flow.** `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
with JSON metadata → the `Location` header is the resumable session URI → `PUT` the bytes.
A vertical or square video of up to three minutes becomes a Short automatically. There is no
Shorts flag.

**Private lock removed.** Revision history, 2026-11-02: "Videos uploaded through the videos.insert
method from unverified API projects are no longer restricted to private viewing mode." If
`privacyStatus` is omitted the upload defaults to **public**. The pipeline always sets it
explicitly: `unlisted` while the platform's `visibility` is `private`, and `public` after the owner
changes it. `DRY_RUN` makes no upload at all.
[Revision history](https://developers.google.com/youtube/v3/revision_history)

**Quota.** Granular buckets since 2026-06-01: 100 `videos.insert` calls per day in their own
bucket, and 10,000 units per day for other endpoints. `videos.list` costs 1 unit,
`thumbnails.set` 50. Two uploads a day use 2% of the upload bucket. The old figure of 1,600 units
per upload is obsolete. Confirm the bucket size on the project's quota page during setup.
[Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)

**OAuth.** Create a Desktop-app OAuth client and use a loopback redirect. The consent screen must
be "In production": in "Testing" status the refresh token expires after 7 days. An unverified
production app is allowed for personal use under 100 users, with a warning screen at consent.
Refresh tokens die if unused for six months or revoked. Scopes requested once, up front:
`youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`.

**AI disclosure.** `status.containsSyntheticMedia: true`. Required for realistic altered or
synthetic content. Non-realistic content and production assistance are exempt. A realistic
AI-generated clip must be disclosed. A text-to-speech voice over motion graphics is a grey area.
[Policy](https://support.google.com/youtube/answer/14328491)

**Spam policy. This is the largest account risk in the project.** "Using automated tools or AI to
churn out high volumes of similar content with minimal changes. While … posting a few variations
of a video is ok, we don't allow use of these tools to flood our platform." Consequences include
strikes and channel termination.
[Spam policies](https://support.google.com/youtube/answer/2801973)

**Metrics.** `videos.list?part=statistics` for views, likes and comments (1 unit). Average view
duration needs the YouTube Analytics API `reports.query`.

**Also set.** `selfDeclaredMadeForKids: false`, title of at most 100 characters.

---

## Meta — Facebook Page Reels

**Flow.**
1. `POST https://graph.facebook.com/v27.0/{page-id}/video_reels` with `upload_phase=start` → `video_id`.
2. `POST https://rupload.facebook.com/video-upload/v27.0/{video-id}` with headers `offset` and `file_size` and the bytes.
3. `GET /{video-id}?fields=status` until processing is done.
4. `POST /{page-id}/video_reels` with `upload_phase=finish`, `video_state=PUBLISHED`, `description`.

[Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing)

**Permissions.** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Add
`business_management` if the Page sits in a business portfolio. `publish_video` is not required.

**App mode.** Development mode: "Any data generated while an app is in Development mode, such as
test posts, can only be seen by role users." That is the private test post. For public posts the
app goes Live. Business apps get Standard Access automatically, and Standard Access covers users
who have a role on the app, which is our only user. The docs are ambiguous about Live plus Standard
Access, so Phase 5 confirms it by viewing the Reel logged out **(unverified until then)**. Fallback:
App Review plus Business Verification, which takes weeks.

**Tokens.** Short-lived user token (Graph API Explorer) → long-lived user token (about 60 days) →
Page token from `/me/accounts`. "Long-lived Page access token do not have an expiration date." It
can still be invalidated by a password change, a role change or an app-secret reset, so the
pipeline checks it daily with `/debug_token` and alerts.

**Limits.** 30 API-published Reels per Page per 24 hours. 9:16, 1080×1920 recommended, 24–60 fps,
**3 to 90 seconds**, H.264, AAC 48 kHz.

**AI disclosure.** `is_ai_generated` on `/{page-id}/video_reels`: "A boolean flag for developers to
self-claim whether the video was created with AI."
[Reference](https://developers.facebook.com/docs/graph-api/reference/page/video_reels/)

**Metrics.** `GET /{video-id}/video_insights`: `fb_reels_total_plays`, `blue_reels_play_count`,
`post_video_avg_time_watched`.

---

## Instagram — Reels

Checked first-hand on 2026-11-12 in Meta's content publishing guide and media reference.

**Flow.**
1. `POST https://graph.facebook.com/v27.0/{ig-user-id}/media` with `media_type=REELS`, `upload_type=resumable`, `caption` and `share_to_feed=true` → container ID.
2. `POST https://rupload.facebook.com/ig-api-upload/v27.0/{container-id}` with headers `offset: 0` and `file_size` and the bytes.
3. `GET /{container-id}?fields=status_code` until `FINISHED`.
4. `POST /{ig-user-id}/media_publish` with `creation_id={container-id}` → media ID.

[Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing),
[IG User media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media)

Resumable upload is "Only for apps that have implemented Facebook Login for Business." The other
route is `video_url`, which Meta fetches from "a public server". The pipeline uses the resumable
upload, so it needs no public host.

**Account.** A professional (Business or Creator) Instagram account linked to the Facebook Page.
The Instagram user ID is read from the Page (`/{page-id}?fields=instagram_business_account`). The
same Meta app and the same non-expiring Page token serve Facebook and Instagram.

**Permissions.** `instagram_basic` and `instagram_content_publish`, plus the Page permissions
listed under Facebook. Standard Access covers users with a role on the app **(unverified until the
Phase 5 test)**.

**Limits.** "Instagram accounts are limited to 100 API-published posts within a 24-hour moving
period", enforced at `media_publish`. `GET /{ig-user-id}/content_publishing_limit` reports usage.
Reels: MP4 or MOV with the moov atom at the front, 23–60 fps, 9:16 recommended, at most 25 Mbps,
3 seconds to 15 minutes, at most 300 MB.

**Container states.** `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR`, `EXPIRED`. A container that
is not published within 24 hours expires. The publisher reads the state before any retry, so a
lost response to `media_publish` cannot cause a second post.

**No private posts.** Professional accounts are public and the API has no unlisted mode. With
`visibility: 'private'` the pipeline uploads the Reel and waits for `FINISHED`, which proves the
token, the upload and Instagram's processing, and then does not publish. The container expires on
its own.

**AI disclosure.** The media reference lists no AI-disclosure parameter. Instagram adds its own
"AI info" label when it detects AI content. When a render contains AI-generated footage, the
caption ends with the line "Video includes AI-generated footage."

**Links.** Caption links are not clickable. The call to action is "Link in bio", and the store link
goes in the profile.

**Metrics.** `GET /{ig-media-id}/insights` for views, reach, likes, comments, shares, saves and
watch time **(metric names unverified; several were renamed in 2025)**.

---

## AI-disclosure matrix

Computed per render from its manifest. No one sets these by hand.

| What the render contains | TikTok `is_aigc` | YouTube `containsSyntheticMedia` | Facebook `is_ai_generated` | Instagram |
|---|---|---|---|---|
| AI-generated video clip (Tier 1 or 2) | true | true | true | A line in the caption |
| AI-generated music | true | true | true | — |
| Real photos, motion graphics, synthetic voice only (Tier 0) | `disclosure.tier0`, default true | `disclosure.tier0`, default true | `disclosure.tier0`, default true | — |

Tier 0 is a grey area on every platform. The default over-discloses, because an unlabeled video
can be removed and a labeled one is not penalized by the published policies.

## Duplicate and repetitive content

| Platform | Policy | Consequence |
|---|---|---|
| YouTube | Mass-produced similar content "with minimal changes" | Strikes, termination |
| TikTok | "ineligible for the FYF if it includes unoriginal or reused material without anything new" | Reach suppression, posting restrictions |
| Facebook | Duplicates are demoted; repeated reuse reduces distribution | Reach suppression |
| Instagram | Recommendations favour original content; duplicates are not recommended to non-followers (policy text not fetched) **(unverified)** | Reach suppression |

The store has **one product and ten photos**. Sixty posts a month per platform about one product is
the pattern these policies describe. What the pipeline does about it:

- Every slot differs in hook, template, photo sequence, palette, voice, music, caption and hashtags.
- No hook repeats on a platform within 14 days. At 2 slots a day that needs at least 28 live hooks, so the library holds 40 or more and refills itself.
- Tier 1 and 2 clips add footage that does not exist in the photo set.
- Cadence is configurable per platform, so one platform can drop to 1 a day without touching the others.
- Phase 8 watches reach per platform and alerts on a sustained drop.

This reduces the risk. It does not remove it. More products, or more photos and facts for this one,
help more than any setting.

## Common upload file

One encode satisfies all four platforms: MP4, H.264 High, `yuv420p`, 1080×1920, 30 fps, about
8 Mbps, AAC-LC 48 kHz stereo, `+faststart`, 15 s ±1 s, roughly 15 MB. Loudness target −14 LUFS
integrated, true peak ≤ −1 dBTP (platform targets unverified).

**Safe zones.** Official pages did not load during research. Third-party guides to Meta's Reels
ad spec say to keep text out of the top 14%, bottom 35% and outer 6%. That reserve is for paid ads,
which carry a button and a longer caption, and on 1080×1920 it leaves text less than half the
frame. The config starts from smaller estimates for organic posts: about 200–220 px at the top,
480–520 px at the bottom, 60 px on the left and 120–160 px on the right for the action buttons.
Each platform has its own preset, and Phase 5 test posts are checked by eye against the real UI
**(unverified until then)**. Only text is kept inside the safe zone. Photos use the whole frame.

## What the owner has to set up

| Platform | Steps | Time |
|---|---|---|
| YouTube | Google Cloud project, enable YouTube Data API v3 and YouTube Analytics API, consent screen External + In production, Desktop OAuth client | 15 min |
| Facebook | Meta app (type Business), user token from Graph API Explorer, switch app to Live | 15 min |
| TikTok | Sandbox app for the test post (Login Kit + Content Posting API, Desktop redirect). Bridge account for public posting | 20 min |
| Instagram | Make the Instagram account a professional account and link it to the Facebook Page. Add the Instagram permissions to the same Meta app | 10 min |

The store already serves `/policies/privacy-policy` and `/policies/terms-of-service`, which cover
the privacy and terms URLs these developer portals ask for.
