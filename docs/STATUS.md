# Status

Updated 2026-11-12.

| Phase | State | Exit criterion met |
|---|---|---|
| 0 Research and plan | Done, reviewed by Opus, revised | Yes |
| 1 Scaffold | Done, reviewed by Opus, fixes applied | Yes: `docker compose up` runs healthy as a non-root user |
| 2 Ingest | Done, reviewed by Opus, fixes applied | Yes: brief built from the live store |
| 3 Creative | Done, reviewed by Opus, fixes applied | Yes: three sample ads rendered and sent to the owner |
| 4 Tiers | In progress: router and ledger. Real providers wait for keys | |
| 5 Publishing | Waits for platform credentials | |
| 6 Scheduler and ops | Loop exists. Summary, housekeeping and backups to do | |
| 7 Deploy | | |
| 8 Feedback | | |

## Decisions from the owner (2026-11-12)

- The fourth platform is Instagram Reels. LinkedIn is dropped.
- TikTok goes through a hosted bridge.
- The store is now called Giftwell and has three employees. Shopify still reports "Merry Marts", so `brand.name` in config sets the name ads use.
- Web pages are read with the Playwright CLI.
- API keys arrive on 2026-11-13.

## What has been seen working

- **The whole chain with model calls stubbed.** Ingest from the live store, two slots planned and produced (eight renders in 2 min 36 s, all passing QA), slot 1 dry-published to four platforms with a title and caption each. The same run passes inside the Docker container.
- **Three ad designs.** Dark kinetic, light cosy and festive gift guide. All sample renders pass the QA gate: 15 s, 1080×1920, 30 fps, −14.2 LUFS, no black or frozen frames.
- **Claim checks.** The three sample scripts pass. Rejected in tests: a wrong price on screen or spoken, number words with no supporting fact, discount and urgency wording, "bestseller" with a zero-width character or a Cyrillic look-alike letter, `#50OFF`, "Over 10,000 sold" in a caption.
- **Docker.** The image (4.1 GB) carries Chrome, Python and the voice model and renders under `cap_drop: ALL`, `no-new-privileges`, a memory limit and a non-root user. `docker compose up` reaches healthy.
- **Scheduler and publishing state machine.** Atomic claims, fencing, crash recovery, lateness and retries are covered by tests. Rendering runs in a child process and publishing continues meanwhile.
- **Tests.** 122 pass. Type check clean.

## Not verified

- **Anything that calls a live model.** There is no Anthropic API key here. Scripts, hooks, claim judging and copy have only run against fixtures and a fake client.
- **Audio by ear.** Speech and music are checked by measurement only.
- **Cancelling a real render on timeout.** Tested with a plain process, not with Chrome.
- **Platform facts** reported by research agents. `PLATFORMS.md` marks them. Instagram's were read first-hand.
- **Safe zones.** Estimates until a real post on each platform is looked at.

## Planned and not built

- Vision QA of rendered frames, automatic photo tagging, and the check of an AI clip against its source photo. All three need image input to the model client and a key to verify against.
- Shopify Admin API mode. Needs credentials to verify against.
- Real clip providers and all four publishers. Need keys.

## Blockers

- **No API keys yet**: Anthropic, platform apps, bridge, clip providers.
- **The public product feed rate-limits** (HTTP 429 seen many times). Retries cope. Shopify app credentials would remove it.
- **The Higgsfield MCP server needs signing in again** (`/mcp`). It is only used at build time.

## Needed from the owner

One list, with steps: `OWNER_SETUP.md`.
