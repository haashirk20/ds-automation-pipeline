# Status

Updated 2026-11-12.

| Phase | State | Exit criterion met |
|---|---|---|
| 0 Research and plan | Done, reviewed by Opus, revised | Yes |
| 1 Scaffold | Done, reviewed by Opus, fixes applied | Natively yes. `docker compose up` not run: see blockers |
| 2 Ingest | In progress | |
| 3 Creative | In progress: voice and music tools built, render engine proven | |
| 4 Tiers | | |
| 5 Publishing | | |
| 6 Scheduler and ops | | |
| 7 Deploy | | |
| 8 Feedback | | |

## What has been seen working

- **Phase 1.** 41 tests pass and the type check is clean. A simulated day in `DRY_RUN` plans two
  slots, stub-produces them and publishes slot 1 to four platforms once, with no duplicates when
  the same minute runs again. Covered by tests: atomic claim, fencing against a late finisher, a
  publisher that hangs, crash recovery in every branch, lateness, alert delivery and redaction.
- **Voice.** `tools/tts`: a four-line script becomes 12.4 s of speech with a start and end time for
  every word, in 6 s on this machine's CPU. 18 tests.
- **Rendering.** Remotion rendered 15 s at 1080×1920 and 30 fps in 17.6 s here, with H.264 video
  and AAC audio. Assets copied into the bundle after bundling are served, so one bundle serves
  every slot.
- **Store.** One product, three variants, ten photos, $49.99 CAD, read from the public feed.

## Not verified

- **Docker.** The Dockerfile, `compose.yaml` and the CI Docker steps have never been executed.
- **Anything that calls a model.** There is no Anthropic API key here, so model steps run on fixtures.
- **Audio by ear.** Speech and music are checked by measurement only. The owner should listen to the samples.
- **Platform facts** reported by research agents and not re-checked first-hand. `PLATFORMS.md` marks them.

## Blockers

- **Docker is not usable in this WSL distro.** Docker Desktop is installed on Windows with WSL
  integration off, and there is no passwordless sudo.
- **No Anthropic API key.**
- **The Shopify connector is present but not signed in.** The public product feed is used
  instead. It rate-limits (HTTP 429 seen three times).

The Higgsfield MCP server is connected: plan "ultra", 523 credits on 2026-11-12, no TikTok account
linked. Nothing has been spent.

## Needed from the owner

One list, with steps: `OWNER_SETUP.md`.
