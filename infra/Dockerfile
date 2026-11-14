# node:24.22.2-bookworm-slim, index digest (multi-arch), see docs/INSTALLED.md
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
WORKDIR /app

# Libraries Chrome Headless Shell needs, the list from https://www.remotion.dev/docs/docker, plus CA
# certificates for the build-time model download (the slim image has none), plus a colour emoji font:
# captions carry emoji and Chrome draws empty boxes without one. The font is pinned (docs/INSTALLED.md):
# if Debian replaces this version the build fails here, and the pin is updated on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 ca-certificates \
    fonts-noto-color-emoji=2.042-0+deb12u1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# Chrome Headless Shell lands in node_modules/.remotion, read-only at run time.
RUN node -e "import('@remotion/renderer').then((m) => m.ensureBrowser())"

# uv from the official image, pinned by digest (docs/INSTALLED.md). Python 3.12 is uv's own build,
# kept outside the project so it stays readable by the node user.
COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_PREFERENCE=only-managed UV_CACHE_DIR=/tmp/uv-cache
COPY tools/tts/pyproject.toml tools/tts/uv.lock tools/tts/
COPY tools/music/pyproject.toml tools/music/uv.lock tools/music/
RUN uv python install 3.12.16 \
  && uv sync --frozen --no-dev --project tools/tts \
  && uv sync --frozen --no-dev --project tools/music \
  && rm -rf /tmp/uv-cache

# The voice model is baked in. HF_HUB_OFFLINE is set only afterwards, so nothing downloads at run time.
ENV HF_HOME=/opt/hf
COPY tools/ tools/
RUN uv run --no-sync --project tools/tts python tools/tts/tts.py --warm && rm -rf /tmp/uv-cache
# The model cache is root-owned and read-only to the node user; offline mode needs no writes there.
RUN chmod -R a-w /opt/hf
ENV HF_HUB_OFFLINE=1 UV_NO_SYNC=1

COPY src/ src/
COPY config/ config/
COPY templates/ templates/
COPY prompts/ prompts/
# The Remotion bundle is made once, here, and reused by every render; staging writes into it, so the node user owns it.
ENV BUNDLE_CACHE_DIR=/opt/bundle
RUN node -e "import('./src/render/render.ts').then((m) => m.getBundle())" && chown -R node:node /opt/bundle
# Named volumes copy this ownership on first use.
RUN mkdir -p data out backup-status && chown node:node data out backup-status
USER node
CMD ["node","src/cli.ts","run"]
