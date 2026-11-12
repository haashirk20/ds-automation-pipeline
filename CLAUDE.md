# Shopify product → video ad → publisher

An unattended pipeline. One Shopify product goes in. Two 15-second vertical ads a day come out and
are published to YouTube Shorts, Facebook Page Reels, LinkedIn and TikTok.

Read `docs/ARCHITECTURE.md` before a structural change and `docs/DECISIONS.md` before proposing a
tool, service or dependency. `docs/PLATFORMS.md` holds the API facts the publishers depend on.
`docs/STATUS.md` says which phase is current and what is blocked.

## Commands

```bash
npm test                                   # node:test
npm run typecheck                          # tsc --noEmit
node src/cli.ts doctor                     # config, database, secrets present, heartbeat
DRY_RUN=1 node src/cli.ts run --once       # one tick, no publish calls
DRY_RUN=1 node src/cli.ts run --once --now 2026-11-12T17:20:00Z   # one tick at a chosen time
docker compose up -d                       # the whole deployment
```

## Rules that must hold

- **Runtime is deterministic code.** Model calls live only in `src/creative`, the vision part of
  `src/qa`, and the weekly review in `src/feedback`. Each is one request with a structured answer.
  No agent loops and no long-lived model session.
- **Never double-post.** A publisher calls `saveHandle` before any request that could create a
  post, and on every call it uses the stored handle first to find out what already happened. No
  stored handle must mean nothing was posted. If the state is ambiguous the publication becomes
  `needs_attention`. It is never re-posted blindly. Every write after a claim carries the claim
  time as a fencing token, and every publisher passes `signal` to its requests.
- **`DRY_RUN=1` skips the publish call and nothing else.**
- **Ad claims come from the Shopify brief only.** Tags are not claims. No discounts, reviews or
  statistics that the store data does not contain.
- **Every paid job checks price and remaining budget first** and writes a ledger row.
- **Secrets live in `.env`.** Rotating OAuth tokens live in the database. Neither is ever logged.
- **No new dependency or service** without an entry in `docs/DECISIONS.md` (alternatives and
  reason) and a row in `docs/INSTALLED.md` (exact version, licence). Exact pins only.
- **Third-party repositories** go in `third_party/` at a pinned commit and run in containers only.
  Never pipe a remote script into a shell.

## Code conventions

- TypeScript that Node 24 runs directly: erasable syntax only (no enums, namespaces or parameter
  properties) and relative imports with the `.ts` extension. There is no build step.
- Functions that depend on the time take `now: Date`. Only `src/cli.ts` reads the clock.
- Built-ins first: `fetch`, `node:sqlite`, `node:test`, `process.loadEnvFile`.
- Tests go in `tests/` and use a fresh temporary `DATA_DIR`.
- One JSON object per log line. Use the logger so redaction applies.

## Working in phases

For each phase: implement, verify the exit criterion by running it, get the Opus review and the
security review, commit, update `docs/STATUS.md`. When a tool or API fails twice, record why in
`docs/DECISIONS.md` under "Attempts abandoned" and move to the next alternative.

## Who does what at build time

| Agent | Model | Work |
|---|---|---|
| `architect` | Opus | Architecture decisions, research synthesis, final review of each phase |
| `security-reviewer` | Opus | Security review of each phase |
| `implementer` | Sonnet | Modules, tests, Docker and infrastructure, integration |
| `scout` | Haiku | Reading docs, licence and version checks, configs, lint fixes, log triage |

The orchestrator plans, routes, reviews diffs, resolves conflicts between agents and keeps
`docs/DECISIONS.md` current. Rote work goes to the cheapest agent that can do it.
