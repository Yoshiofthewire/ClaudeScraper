FROM node:22.23.1-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && rm -rf /var/lib/apt/lists/*


FROM node:22.23.1-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.211 \
  && mkdir -p /home/node/workspace /data

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh ./bin/claude-usage.js ./bin/claude-usage-server.js

ENV CLAUDE_CONFIG_DIR=/data
ENV CLAUDE_USAGE_WORKDIR=/home/node/workspace
VOLUME /data
EXPOSE 8080

ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]
CMD []
