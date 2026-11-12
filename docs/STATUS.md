# Status

Updated 2026-11-11.

| Phase | State | Exit criterion met |
|---|---|---|
| 0 Research and plan | Done | Yes: `ARCHITECTURE.md`, `PLATFORMS.md`, `COSTS.md`, `DECISIONS.md` |
| 1 Scaffold | Next | |
| 2 Ingest | | |
| 3 Creative | | |
| 4 Tiers | | |
| 5 Publishing | | |
| 6 Scheduler and ops | | |
| 7 Deploy | | |
| 8 Feedback | | |

## Phase 0

Checked first-hand:

- The store is reachable without a password. One product, three variants, ten photos, $49.99 CAD.
- YouTube's revision history, entry of 2026-11-02: uploads from unverified projects are no longer private-locked.
- Zernio and Upload-Post pricing pages.
- On this machine: Node v24.22.2 runs TypeScript directly and `node:sqlite` works. Chromium's
  system libraries are present, so Remotion can render here. Python 3.12 and uv are present.
- Remotion 4.0.543 has a Linux ARM64 build.

Reported by research agents with sources, not re-checked first-hand: TikTok audit wording and token
lifetimes, Meta Reels flow and `is_ai_generated`, LinkedIn requirements, Postiz internals, VM and
clip prices. `PLATFORMS.md` and `COSTS.md` mark what is unverified.

## Blockers and gaps

- **Docker is not usable in this WSL distro.** Docker Desktop is installed on Windows with WSL
  integration off, and there is no passwordless sudo. Until it is switched on, `docker compose up`
  cannot be run here and Phase 1 is verified natively instead.
- **No Anthropic API key in the environment.** Model steps run against fixtures (`LLM_STUB=1`) until one is provided.
- **No FFmpeg, C++ toolchain or GPU on this machine.** FFmpeg comes from a pinned static build for local runs and from the image in Docker.
- **The Higgsfield and Shopify MCP servers are not connected in this session.**

## Needed from the owner

Collected into one request at the end of Phase 1:

- Platform credentials and one-time logins: YouTube, Facebook, LinkedIn, TikTok.
- TikTok route and LinkedIn target (see `DECISIONS.md`, "Assumptions to confirm").
- Anthropic API key. Optional: Shopify Dev Dashboard app credentials, fal.ai and Higgsfield keys.
- Brand assets: logo, colours, fonts, voice.
- An alert destination: Discord webhook or Telegram bot.
- A VM account, for Phase 7.
- Docker Desktop: Settings → Resources → WSL integration → enable for this distro.
