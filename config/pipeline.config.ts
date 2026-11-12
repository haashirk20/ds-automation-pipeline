// Default pipeline config. Validated at startup by src/config/index.ts.
// All times are local to `timezone`, 24h HH:MM.
export default {
  timezone: 'America/Toronto',
  // Produce tomorrow's slots at this local time, the evening before.
  produceAt: '21:00',
  platforms: {
    // visibility: 'public' | 'private'. Private means YouTube unlisted, TikTok SELF_ONLY,
    // Facebook app in Development mode, LinkedIn draft. The owner switches to 'public' when ready.
    // Slot index i on every enabled platform publishes the same master edit,
    // so every enabled platform needs the same NUMBER of slots.
    youtube: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'] },
    facebook: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'] },
    // target: 'organization' | 'member'
    linkedin: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], target: 'member' },
    // mode: 'bridge' | 'direct' | 'inbox'
    tiktok: { enabled: true, visibility: 'private', slots: ['12:15', '19:45'], mode: 'direct' },
  },
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
