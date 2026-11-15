# Status

Updated 2026-11-14.

| Phase | State |
|---|---|
| 0 Research and plan | Done |
| 1 Scaffold | Done |
| 2 Ingest | Done |
| 3 Creative | Done |
| 4 Tiers | Done in `ugc` mode, with Higgsfield as tier 2. There is no tier 1 provider |
| 5 Publishing | YouTube and TikTok live-tested privately through the bridge. Facebook and Instagram are not connected |
| 6 Scheduler and ops | Built, not done. The loop, recovery, daily summary, second dead-man's switch, disk alert, housekeeping, snapshot and backup service exist. The exit criterion's one real day has not run. A backup and restore round-trip to R2 from a one-off restic container passed on 2026-11-14; the backup service has not yet sent the real database to R2 |
| 6b Admin | Built; tests pass. A local walk-through in a throwaway compose project passed: password, port bound to 127.0.0.1 only, Host 421, settings and prompt edits through the browser, the tick picking up a version, rollback, guardrail refusal. A backup round-trip to R2 from a one-off restic container passed. Not yet run: the walk-through on the VM over an SSH tunnel, the check that the port is unreachable from outside the VM, and Tailscale |
| 6c Posts, music, models | Built, uncommitted; tests pass. A Posts page (held manual posts, D-33), a Music page (D-34), a Models page and four presets (D-35), and the live quote in the ledger. The browser walk-through in a throwaway compose project passed: four uploads accepted, a renamed text file refused, a held post then Post then published with `dry_run=1`, Discard skipped, a custom model held then approved, the duck measured 10.1 dB against a target of -10, Range 206 and 416, and a 38.4 MB upload peaked at 199.5 MiB with 22 pids. The Opus and security reviews are done and their fixes applied (skipped bad custom rows, silent-clip rejection, streamed uploads, 0-byte media, upload format and codec whitelists). A 40 MB upload against the harness peaked at 344 MB VmHWM (426 MB before the streaming fix), and the admin limit is now 640m. The stub run covers the live-quote ledger path (the fake provider returns credits); a real paid job has not. Not yet run: a real manual post with one paid clip, after the 24-hour dry run ends |
| 7 Deploy | Not started |
| 8 Feedback | Not started |

The tests pass (365 of 365 at the last full run, 2026-11-14) and the type check is clean. An Opus architect review and an Opus
security review of the bridge, MCP and `ugc` code were done on 2026-11-14 and their fixes applied.

## Verified live

- **Phase 6 compressed-time run.** 26 of 26 assertions over 614 simulated ticks: two dry-run posts a
  day per platform, a webhook outage day, cleanup and the snapshot. The compose stack came up
  healthy, with a local restic backup and restore.
- **Bridge posts, 2026-11-13.** A private YouTube video and a TikTok inbox draft were posted, and a
  second run resumed both from the stored handle without a second post (D-29).
- **Model calls, 2026-11-14.** The concept writer, the claim judge, the frame check, and the copy
  writer and judge ran against the live API. About $0.31 was spent in all.
- **Frame check calibration, 2026-11-14.** Five runs each of five labelled clips gave the expected
  verdict 25 of 25 times (D-28).
- **Docker.** The image was rebuilt with the pinned emoji font.
- **Higgsfield sign-in.** `doctor` reported a signed-in token on 2026-11-14.
- **Paid end-to-end job, 2026-11-14.** Slot 2026-11-14#2 was ready in 395 s on tier t2 with one Wan 3.0
  clip, $0.588 in all. The frame check passed. It was not posted (`DRY_RUN=1`). Phase 6's "one real day"
  remains open.

## Not verified

- Phase 6: one real day, and the backup service's first nightly backup of the real database to R2.
- A full slot posted end to end with a real clip. The 2026-11-14 run reached `ready` and was not posted.
- Discord alert delivery.
- Facebook and Instagram posts, and a public TikTok post.
- The `umask` and database file-mode change has no test.
- Phase 6c: the new admin limit of 640m and the upload whitelists under the real container (the walk-through ran before them), Remotion's looped music with the extended volume curve in a real render, Seedance 2.5 with reference images in `omni_reference` mode, a real paid job through the live-quote ledger, and whether three manual posts a day on top of the planned two trip a platform limit.

## Known gaps

- The frame check is split on the Seedance 2.0 fast sample because of a hood-like collar. It passes
  the Wan 3.0 sample.
- A fresh install has no stored clips for the first 14 days (`ugc.reuseAfterDays`), so a slot that
  cannot make a new clip fails or waits.

## Owner

`docs/OWNER_SETUP.md` lists what the owner must do.

## Next

1. Phase 6: one real day, with the backup service sending its first nightly backup to Cloudflare R2.
2. Phase 7: deploy, then a 48-hour unattended run.
3. Phase 8: the feedback loop, using the bridge's analytics (D-29).
