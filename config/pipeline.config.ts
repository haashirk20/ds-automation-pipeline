// Default pipeline config. Validated at startup by src/config/index.ts.
// All times are local to `timezone`, 24h HH:MM.
export default {
  timezone: 'America/Toronto',
  // Produce tomorrow's slots at this local time, the evening before.
  produceAt: '21:00',
  platforms: {
    // visibility: 'public' | 'private'. Private means YouTube unlisted, TikTok SELF_ONLY,
    // Facebook app in Development mode, Instagram uploaded and processed but not published.
    // The owner switches to 'public' when ready.
    // Slot index i on every enabled platform publishes the same master edit,
    // so every enabled platform needs the same NUMBER of slots.
    // cta: what the end card tells the viewer to do on that platform.
    // safe: pixels kept clear of text on each edge of the 1080x1920 frame. These are starting values
    // from third-party guides; check them against a real post and adjust.
    youtube: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in description', safe: { top: 250, bottom: 560, left: 60, right: 180 } },
    facebook: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Shop now', safe: { top: 270, bottom: 672, left: 65, right: 65 } },
    // Instagram and TikTok caption links are not clickable: put the store link in each bio.
    instagram: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in bio', safe: { top: 270, bottom: 672, left: 65, right: 120 } },
    // mode: 'bridge' (public, through a hosted bridge) | 'direct' (own app, private only) | 'inbox' (drafts)
    tiktok: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], cta: 'Link in bio', safe: { top: 250, bottom: 620, left: 60, right: 180 }, mode: 'bridge' },
  },
  creative: {
    // Kokoro voices to rotate through. See tools/tts/tts.py for the allowed list.
    voices: ['af_heart', 'af_bella', 'am_michael'],
    // A synthesized bed under the voice. gainDb is relative to the bed's own level.
    music: { enabled: true, gainDb: -8 },
  },
  // Claims printed only on product photos are not used unless this is true. Care, safety and battery
  // claims are never taken from a photo.
  claims: { fromPhotos: false },
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
  // A tick running longer than this makes the process exit so Docker restarts it.
  watchdogMinutes: 45,
};
