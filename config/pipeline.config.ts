// Tier 2 is the Higgsfield tier; the admin page may switch to any entry of tiers.t2Presets.
const WAN = { provider: 'higgsfield', model: 'wan3_0', usdPerClip: 0.57, params: { resolution: '720p', generate_audio: true }, maxCredits: 30, keepCredits: 350 };

// Default pipeline config. Validated at startup by src/config/index.ts.
// All times are local to `timezone`, 24h HH:MM.
export default {
  timezone: 'America/Toronto',
  // Produce tomorrow's slots at this local time, the evening before.
  produceAt: '21:00',
  platforms: {
    // Every platform publishes through the hosted bridge (Zernio). handle: the account name at the
    // bridge (Facebook: the Page name). Facebook and Instagram are off until their accounts are
    // connected at the bridge.
    // visibility: 'public' | 'private'. Private means YouTube private, TikTok a draft in the account's inbox, Facebook
    // a draft in Publishing Tools. Instagram has no private mode: private there is refused.
    // The owner switches to 'public' when ready.
    // Slot index i on every enabled platform publishes the same master edit,
    // so every enabled platform needs the same NUMBER of slots.
    // cta: what the end card tells the viewer to do on that platform.
    // safe: pixels kept clear of text on each edge of the 1080x1920 frame. Estimates for organic
    // posts (the published figures are for paid ads and reserve more). Check them against a real
    // post on each platform and adjust.
    youtube: { handle: 'shopgiftwell', enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in bio', safe: { top: 200, bottom: 480, left: 60, right: 160 } },
    facebook: { handle: 'Merry Marts', enabled: false, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Shop now', safe: { top: 220, bottom: 480, left: 60, right: 120 } },
    // Instagram and TikTok captions and YouTube Shorts descriptions do not link: put the store link in each bio or channel.
    instagram: { handle: 'shopgiftwellgifts', enabled: false, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in bio', safe: { top: 220, bottom: 480, left: 60, right: 120 } },
    tiktok: { handle: 'merrymarts', enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in bio', safe: { top: 220, bottom: 520, left: 60, right: 160 } },
  },
  // The name ads say and show. null uses the store name Shopify reports (still "Merry Marts").
  brand: {
    name: 'Giftwell',
    // Sent to the video model as a reference so a gift box in the scene carries the right logo.
    // A path from the repository root, or null to send none.
    logo: 'config/brand/logo.png',
  },
  creative: {
    // 'ugc' = one AI-generated scene with a caption on top; 'ad' = photo templates with a voice-over.
    mode: 'ugc',
    // Kokoro voices to rotate through. See tools/tts/tts.py for the allowed list.
    voices: ['af_heart', 'af_bella', 'am_michael'],
    // A synthesized bed under the voice. gainDb is relative to the bed's own level.
    music: { enabled: true, gainDb: -8 },
  },
  // The 'ugc' mode. reuseAfterDays: a stored clip may be posted again after this many days when no new
  // clip can be made. captionPx: caption text size on the 1080-wide frame.
  // music: the owner's uploaded track, mixed under the clip's sound. volumeDb is its level; duckDb is how far it drops while the
  // spoken line plays.
  ugc: { reuseAfterDays: 14, captionPx: 84, music: { volumeDb: -18, duckDb: -10 } },
  // The admin page's Post button makes a held clip on demand. manualPerDay: most per local day (0 turns the button off).
  // expireHours: a held clip nobody posted is discarded after this long.
  approval: { manualPerDay: 3, expireHours: 24 },
  llm: {
    models: { script: 'claude-sonnet-5-5', copy: 'claude-haiku-5-5', qa: 'claude-haiku-5-5' },
    // At this spend in a calendar month (UTC) model calls stop and approved scripts are reused.
    monthlyCapUsd: 10,
  },
  // A hook is not reused within noRepeatDays. The library is kept at
  // noRepeatDays x slots per day x poolFactor hooks or more.
  hooks: { noRepeatDays: 14, poolFactor: 1.5 },
  publish: {
    // Past this lateness a publication is skipped, not posted.
    maxLatenessMinutes: 360,
    // Delay before retry N (1-based). Exhausted list means skipped.
    retryMinutes: [1, 5, 15, 45, 120],
    // An 'uploading' publication older than this is treated as crashed and recovered.
    uploadTimeoutMinutes: 30,
    // Hard limit for one publisher call. Must be less than uploadTimeoutMinutes, and the four platforms post one after
    // another in a tick, so watchdogMinutes must be at least 4 x this + 5. The video upload inside it is cut off at 6 minutes.
    timeoutMinutes: 10,
  },
  // A 'producing' slot older than produceTimeoutMinutes is retried, up to maxAttempts, then failed. The producer is
  // killed at this limit, so it must outlast the video jobs: a 'ugc' slot may wait for two jobs, each 25 minutes of polling,
  // a 10 minute download and two uploads (the config check requires maxJobsPerSlot * 40 + 10).
  render: { produceTimeoutMinutes: 90, maxAttempts: 2 },
  disclosure: { tier0: true },
  // AI video clips. In 'ugc' mode tier 2 makes the whole video, and t0 means "reuse a stored clip" (see ugc.reuseAfterDays).
  // In 'ad' mode some slots open with one short image-to-video clip made from a product photo: for that
  // mode set mix to all t0 and clipSeconds to 4.
  tiers: {
    // Share of slots per tier: t0 = no new clip, t2 = a new AI clip. Must sum to 1.
    mix: { t0: 0, t2: 1 },
    // Hard monthly dollar cap per paid tier (UTC month). Failed jobs count at their quoted price.
    // The cap of $52 is about 2,400 credits, which is 91 clips at 26.25 credits each.
    capsUsd: { t2: 52 },
    // Length of the clip asked for, in seconds. In 'ugc' mode this must be 14 to 16.
    clipSeconds: 15,
    // Most paid jobs (retries included) one slot may start.
    maxJobsPerSlot: 2,
    // Tier 2 runs on the owner's Higgsfield subscription through its MCP server. The Ultra plan grants
    // 3,000 credits a month and was bought at $65, so one credit is about $0.0217. Wan 3.0 at 720p is
    // quoted at 26.25 credits, so usdPerClip is 0.57. A job quoted above maxCredits is not started, and a job
    // is not started when it would leave fewer than keepCredits credits. keepCredits 350 sits above
    // Higgsfield's auto-refill threshold of 300.
    t2: { ...WAN },
    // Ultra plan price per credit; the ledger records the live quote times this.
    usdPerCredit: 65 / 3000,
    // Ceiling on maxCredits for a model added on the admin page.
    customMaxCredits: 120,
    // The choices the admin page offers for t2. Quotes below are for 15 s, 9:16, read 2026-11-14 with get_cost and no reference
    // images (the pipeline re-quotes with images before every paid call). usdPerClip = credits x usdPerCredit, rounded up to the cent.
    // seedance_2_5* needs mode 'omni_reference' for reference images.
    t2Presets: {
      wan3_0_720p: { ...WAN },
      seedance_2_0_fast_720p: { provider: 'higgsfield', model: 'seedance_2_0', usdPerClip: 0.82, params: { mode: 'fast', resolution: '720p', generate_audio: true }, maxCredits: 40, keepCredits: 350 },
      // Quoted 67.5 credits.
      seedance_2_0_std_720p: { provider: 'higgsfield', model: 'seedance_2_0', usdPerClip: 1.47, params: { mode: 'std', resolution: '720p', generate_audio: true }, maxCredits: 75, keepCredits: 350 },
      // Quoted 75 credits.
      seedance_2_5_flash_720p: { provider: 'higgsfield', model: 'seedance_2_5_flash', usdPerClip: 1.63, params: { mode: 'omni_reference', resolution: '720p', generate_audio: true }, maxCredits: 83, keepCredits: 350 },
      // Quoted 105 credits. At about $2.28 a clip the $52 cap allows about 22 clips a month, so the cap stops it mid-month.
      seedance_2_5_720p: { provider: 'higgsfield', model: 'seedance_2_5', usdPerClip: 2.28, params: { mode: 'omni_reference', resolution: '720p', generate_audio: true }, maxCredits: 116, keepCredits: 350 },
      // Quoted 18.75 credits. Once lit the button blue and failed the frame check (D-30).
      kling_o3_std: { provider: 'higgsfield', model: 'kling_o3_image_reference', usdPerClip: 0.41, params: { mode: 'std', sound: 'on' }, maxCredits: 21, keepCredits: 350 },
    },
  },
  // Operations. summaryAt: local time after which the daily summary for yesterday is sent. snapshotAt: local time
  // after which the nightly database snapshot is written for the backup container; housekeeping runs after it.
  // keepDays: renders, failed attempts and unused clips are deleted after this many days.
  // diskAlertPercent: alert when DATA_DIR or OUT_DIR is fuller than this.
  ops: { summaryAt: '08:00', snapshotAt: '03:30', keepDays: 7, diskAlertPercent: 80 },
  // A tick running longer than this makes the process exit so Docker restarts it.
  watchdogMinutes: 45,
};
