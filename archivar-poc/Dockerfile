FROM node:lts

WORKDIR /app

# Base system deps + keyring dir
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
    && install -m 0755 -d /etc/apt/keyrings

# Docker CE repo (for docker-ce-cli only)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list

# Caddy repo
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null

# Install caddy + docker CLI + ffmpeg (srt/vct export audio extraction);
# clean apt cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends caddy docker-ce-cli ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm (pinned to the packageManager version in package.json)
RUN npm install -g pnpm@9.13.2

# Copy dependency manifests first for better caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies (frozen lockfile for reproducible builds)
RUN pnpm install --frozen-lockfile

# Copy rest of application files
COPY . .

# Copy Docker configuration files
COPY --chmod=0644 docker/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN pnpm build

# Create symlink for sample_data volume mount to be accessible by Astro
RUN ln -sf /sample_data /app/public/sample_data

# Run as the image's built-in `node` user (UID 1000) instead of root.
# Tool containers are started with `--user "$(id -u):$(id -g)"` via the
# mounted Docker socket and inherit this process's identity; a root archivar
# creates root-owned out_* folders that the (UID 1000) segmentation services
# cannot write into. ONE chown -R only — it walks node_modules and duplicates
# every touched file into a new layer.
ENV HOME=/home/node \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_DATA_HOME=/home/node/.local/share
RUN mkdir -p /home/node/.config /home/node/.local/share /data \
    && chown -R node:node /app /home/node /data
USER node

# 8801 is the Astro dev server port (behind Caddy on :80); 9229 reserved for the Node debugger
EXPOSE 8801 9229

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
