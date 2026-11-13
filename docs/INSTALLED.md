# Installed

| What | Exact version / digest / SHA | Licence | Why | Alternatives considered |
|---|---|---|---|---|
| zod (npm, runtime) | 4.6.7 | MIT | Config validation with readable errors | Hand-written checks (more code), ajv (heavier) |
| typescript (npm, dev) | 7.0.2 | Apache-2.0 | Type checking only (`tsc --noEmit`); Node runs the .ts files | None; skipping types loses safety |
| @types/node (npm, dev) | 24.19.2 | MIT | Node type definitions for tsc, pinned to match the Node 24 runtime | None |
| node:24.22.2-bookworm-slim (Docker base image) | sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 (index digest, from Docker Hub API) | MIT (Node) / Debian mix | Runs .ts natively, small, glibc | alpine (musl risks with ffmpeg/sqlite), node:24 full (large) |
| actions/checkout (GitHub Action) | v7.0.1, 3d3c42e5aac5ba805825da76410c181273ba90b1 | MIT | CI checkout | None |
| actions/setup-node (GitHub Action) | v7.1.0, 949feb2413d6458794dcd2491c4babbbce0c15c1 | MIT | CI Node 24 with npm cache | Installing Node by hand |
| Higgsfield MCP (remote, build-time) | https://mcp.higgsfield.ai/mcp | n/a (hosted service) | Build-time video generation experiments | Direct API calls |
| kokoro (PyPI, tools/tts) | 0.9.4 | Apache-2.0 | Kokoro-82M inference with per-word timestamps (D-05, D-06) | kokoro-js (no timestamps), Piper (GPL-3.0) |
| Kokoro-82M weights (Hugging Face hexgrad/Kokoro-82M) | f3ff3571791e39611d31c381e3a41a3af07b4987 | Apache-2.0 | The voice model, fetched into the HF cache by `tts.py --warm` | Paid voice API |
| torch (PyPI, CPU wheel from download.pytorch.org/whl/cpu, tools/tts) | 2.8.0 | BSD-3-Clause | Kokoro's runtime; CPU wheel avoids gigabytes of CUDA libraries | Default PyPI wheel (CUDA, far larger) |
| numpy (PyPI, tools/tts) | 2.2.6 | BSD-3-Clause | Concatenating audio and silence | Pure-Python lists (slow) |
| soundfile (PyPI, tools/tts) | 0.13.1 | BSD-3-Clause | Writes the 16-bit PCM WAV | stdlib `wave` (needs manual float-to-int16 conversion; kept as dependency of kokoro anyway) |
| en_core_web_sm (spaCy model wheel, pinned by URL, tools/tts) | 3.8.0 | MIT | Kokoro's English G2P needs it; pinned so nothing downloads at run time | Letting spaCy fetch it with pip on first use |
| pytest (PyPI, dev, tools/tts) | 8.4.2 | MIT | Tests for tts.py | unittest (more boilerplate) |
| numpy (PyPI, tools/music) | 2.2.6 | BSD-3-Clause | Synthesises the background-music bed (FM, additive, FFT filters and reverb) | Pure-Python lists (far too slow), scipy (heavier, not needed) |
| soundfile (PyPI, tools/music) | 0.13.1 | BSD-3-Clause | Writes the 16-bit PCM WAV | stdlib `wave` (needs manual packing; same pin as tools/tts) |
| pytest (PyPI, dev, tools/music) | 8.4.2 | MIT | Tests for bed.py | unittest (more boilerplate) |

Built-ins used instead of packages: `node:test`, `node:assert`, `node:sqlite`, `fetch`, `process.loadEnvFile`, `Intl`.
| remotion, @remotion/bundler, @remotion/renderer (npm, runtime) | 4.0.543 | Remotion licence: source-available, free up to 3 employees | Renders the ads from React templates. Ships FFmpeg 7.1 and ffprobe | HyperFrames, FFmpeg filtergraphs, MoviePy (D-03) |
| react, react-dom (npm, runtime) | 19.3.1 | MIT | Required by Remotion | None |
| @anthropic-ai/sdk (npm, runtime) | 1.8.0 | Apache-2.0 | All model calls | Raw `fetch` (loses typed errors and helpers) |
| @fontsource/anton, @fontsource/inter, @fontsource/fraunces (npm, runtime) | 5.3.0 | OFL-1.1 | Fonts on disk, so rendering needs no network | Google Fonts at render time (needs network), font files committed to the repo |
| @types/react, @types/react-dom (npm, dev) | 19.3.0 | MIT | Types for the templates | None |
| @playwright/cli (npm, global, build-time only) | 0.1.24 | Apache-2.0 | Reading web pages during research, at the owner's request | Firecrawl (credits ran out mid-task), the Playwright MCP server |
| uv (Docker image ghcr.io/astral-sh/uv, copied into the app image) | 0.13.7, sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 (index digest, `docker buildx imagetools inspect`) | MIT or Apache-2.0 | Installs Python 3.12 and the locked tools/tts and tools/music environments at image build; `uv run --no-sync` at run time | pip and venv (no lockfile support, no managed Python), Debian's python3 (3.11, not 3.12) |
| Debian packages in the app image (libnss3, libdbus-1-3, libatk1.0-0, libgbm-dev, libasound2, libxrandr2, libxkbcommon-dev, libxfixes3, libxcomposite1, libxdamage1, libatk-bridge2.0-0, libpango-1.0-0, libcairo2, libcups2, ca-certificates) | bookworm repository versions at build time | Various, Debian-packaged | The Chrome Headless Shell libraries listed at https://www.remotion.dev/docs/docker; ca-certificates for the build-time Hugging Face download | None; Chrome will not start without them |
| Chrome Headless Shell (downloaded at image build by `ensureBrowser` from @remotion/renderer) | the version @remotion/renderer 4.0.543 pins | BSD-3-Clause (Chromium) | Renders the ad frames | A system Chrome (large, unpinned) |
| CPython (uv-managed build, installed in the app image by `uv python install`) | 3.12.16 | PSF-2.0 | Runs tools/tts and tools/music; exact patch pinned in infra/Dockerfile | Debian python3 (3.11) |
