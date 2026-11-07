FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# Keep the tested host/toolchain independent of the image's rolling OS updates.
RUN npm install --global --prefix /usr/local --no-audit --no-fund \
      bun@1.3.14 opencode-ai@1.18.30 \
    && test "$(/usr/local/bin/bun --version)" = "1.3.14" \
    && test "$(/usr/local/bin/opencode --version)" = "1.18.30" \
    && npm cache clean --force

ENV PATH="/usr/local/bin:${PATH}"
USER node
