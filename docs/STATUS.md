# Status

Updated 2026-11-12.

| Phase | State | Exit criterion met |
|---|---|---|
| 0 Research and plan | Done, reviewed by Opus, revised | Yes |
| 1 Scaffold | Done, reviewed by Opus, fixes applied | Yes: `docker compose up` runs healthy as a non-root user |
| 2 Ingest | In progress | |
| 3 Creative | In progress: voice and music tools built, render engine proven | |
| 4 Tiers | | |
| 5 Publishing | | |
| 6 Scheduler and ops | | |
| 7 Deploy | | |
| 8 Feedback | | |

## Decisions from the owner (2026-11-12)

- The fourth platform is Instagram Reels. LinkedIn is dropped.
- TikTok goes through a hosted bridge.
- The store is now called Giftwell and has three employees.
- Web pages are read with the Playwright CLI.
- API keys arrive on 2026-11-13.

## In progress

- Ingest: `src/shopify/`, migration 002.
- Render pipeline: `templates/`, `src/render/`, `src/tts/`, `src/music/`, `src/creative/assemble.ts`.
- Model client and creative steps: `src/llm/`, `src/creative/`, `prompts/`, migration 003.

After those: a design pass giving the three templates distinct looks, the real `produceSlot` that
joins the pieces, a Docker image that can render, and the three sample ads in `out/samples/`.

Higgsfield cost preflight (no spend): a 5 s vertical clip is 10 credits on `kling3_0` and 35 on
`seedance_2_5`.

## What has been seen working

- **Docker.** The image builds from the pinned base digest in 27 s, `docker compose up` reaches
  healthy, `doctor` exits 0 inside the container, and the process runs as uid 1000.
- **QA gate.** Ten checks on a 15 s file in 0.4 s. On two real renders it failed exactly the
  checks it should have: missing audio, wrong duration, quiet audio.
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

- **The Docker image for rendering.** The current image runs the scheduler with stubs. Chromium, Python and the voice model are not in it yet.
- **Anything that calls a model.** There is no Anthropic API key here, so model steps run on fixtures.
- **Audio by ear.** Speech and music are checked by measurement only. The owner should listen to the samples.
- **Platform facts** reported by research agents and not re-checked first-hand. `PLATFORMS.md` marks them.

## Blockers

- **No Anthropic API key yet.** Model steps run on fixtures.
- **The Shopify connector is present but not signed in.** The public product feed is used
  instead. It rate-limits (HTTP 429 seen several times).

The Higgsfield MCP server is connected: plan "ultra", 523 credits on 2026-11-12, no TikTok account
linked. Nothing has been spent.

## Needed from the owner

One list, with steps: `OWNER_SETUP.md`.
