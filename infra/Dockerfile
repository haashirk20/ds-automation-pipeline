# node:24.22.2-bookworm-slim, index digest (multi-arch), see docs/INSTALLED.md
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ src/
COPY config/ config/
# Named volumes copy this ownership on first use.
RUN mkdir -p data out && chown node:node data out
USER node
CMD ["node","src/cli.ts","run"]
