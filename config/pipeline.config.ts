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
    youtube: { handle: 'shopgiftwell', enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in description', safe: { top: 200, bottom: 480, left: 60, right: 160 } },
    facebook: { handle: 'Merry Marts', enabled: false, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Shop now', safe: { top: 220, bottom: 480, left: 60, right: 120 } },
    // Instagram and TikTok caption links are not clickable: put the store link in each bio.
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
    mode: 'ad',
    // Kokoro voices to rotate through. See tools/tts/tts.py for the allowed list.
    voices: ['af_heart', 'af_bella', 'am_michael'],
    // A synthesized bed under the voice. gainDb is relative to the bed's own level.
    music: { enabled: true, gainDb: -8 },
  },
  // The 'ugc' mode. reuseAfterDays: a stored clip may be posted again after this many days when no new
  // clip can be made. captionPx: caption text size on the 1080-wide frame.
  ugc: { reuseAfterDays: 14, captionPx: 84 },
  llm: {
    models: { script: 'claude-sonnet-5-5', copy: 'claude-haiku-5-5', qa: 'claude-haiku-5-5', escalation: 'claude-opus-5-5' },
    // At this spend in a calendar month (UTC) model calls stop and approved scripts are reused.
    monthlyCapUsd: 10,
    // Opus diagnosis after repeated failures.
    escalationEnabled: false,
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
    // Hard limit for one publisher call. Must be less than uploadTimeoutMinutes.
    timeoutMinutes: 20,
  },
  // A 'producing' slot older than produceTimeoutMinutes is retried, up to maxAttempts, then failed.
  render: { produceTimeoutMinutes: 30, maxAttempts: 2 },
  disclosure: { tier0: true },
  // AI video clips. Some slots open with one short image-to-video clip made from a product photo.
  tiers: {
    // Share of slots per tier: t0 = photos only, t1 = open-weight clip, t2 = premium clip. Must sum to 1.
    // The default is all t0 until a real clip provider is wired in.
    mix: { t0: 1, t1: 0, t2: 0 },
    // Hard monthly dollar cap per paid tier (UTC month). Failed jobs count at their quoted price.
    capsUsd: { t1: 15, t2: 25 },
    // Length of the clip asked for, in seconds.
    clipSeconds: 4,
    // Most paid jobs (retries included) one slot may start.
    maxJobsPerSlot: 2,
    // Tier 1: provider, model id and the price of one clip in dollars.
    t1: { provider: 'fal', model: 'fal-ai/ltx-2-19b/image-to-video', usdPerClip: 0.17 },
    // Tier 2:
    // Tier 2 runs on the owner's Higgsfield subscription through its MCP server. usdPerClip is the quoted
    // credits times what a credit costs on the plan. A job quoted above maxCredits is not started, and a job
    // is not started when it would leave fewer than keepCredits credits.
    t2: { provider: 'higgsfield', model: 'seedance_2_0', usdPerClip: 1.2, params: { mode: 'fast', resolution: '720p', generate_audio: true }, maxCredits: 40, keepCredits: 300 },
  },
  // A tick running longer than this makes the process exit so Docker restarts it.
  watchdogMinutes: 45,
};
