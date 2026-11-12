# node:24.22.2-bookworm-slim, index digest (multi-arch), see docs/INSTALLED.md
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
WORKDIR /app

# Libraries Chrome Headless Shell needs, the list from https://www.remotion.dev/docs/docker, plus CA
# certificates for the build-time model download (the slim image has none).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 ca-certificates \
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
RUN uv python install 3.12 \
  && uv sync --frozen --no-dev --project tools/tts \
  && uv sync --frozen --no-dev --project tools/music \
  && rm -rf /tmp/uv-cache

# The voice model is baked in. HF_HUB_OFFLINE is set only afterwards, so nothing downloads at run time.
ENV HF_HOME=/opt/hf
COPY tools/ tools/
RUN uv run --no-sync --project tools/tts python tools/tts/tts.py --warm && rm -rf /tmp/uv-cache
ENV HF_HUB_OFFLINE=1 UV_NO_SYNC=1

COPY src/ src/
COPY config/ config/
COPY templates/ templates/
COPY prompts/ prompts/
# Named volumes copy this ownership on first use. The Hugging Face cache is written by the node user.
RUN mkdir -p data out && chown -R node:node data out /opt/hf
USER node
CMD ["node","src/cli.ts","run"]
