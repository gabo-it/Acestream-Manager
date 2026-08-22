FROM python:3.10-slim

# AceStream engine version: automatically updated by the GitHub Actions
# workflow (.github/workflows/build-engine.yml), which writes the correct
# number to engine/VERSION and passes it here as a build-arg.
ARG ACESTREAM_VERSION=3.2.11
ARG UBUNTU_CODENAME=22.04

ENV DOWNLOAD_URL="https://download.acestream.media/linux/acestream_${ACESTREAM_VERSION}_ubuntu_${UBUNTU_CODENAME}_x86_64_py3.10.tar.gz"

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Startup script: builds the engine's command-line flags from environment
# variables, so parameters are configurable from the webui (Engine tab)
# without rebuilding the image.
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN useradd --shell /bin/bash --home-dir /srv/ace --create-home ace
USER ace
WORKDIR /srv/ace

RUN wget -qO- "$DOWNLOAD_URL" | tar xz \
    && pip install -q --no-cache-dir --user -r requirements.txt

ENV PATH="/srv/ace/.local/bin:${PATH}"

# The HTTP port is published to the host by docker-compose.yml (needed for
# the native /ace/manifest.m3u8 endpoint used by the HLS playlist) — see
# that file for details. Defaults below, overridable via the HTTP_PORT/PORT
# environment variables (settable from the webui, Engine tab):
ENV HTTP_PORT=6677
ENV PORT=44556
ENV LIVE_CACHE_TYPE=memory
ENV BIND_ALL=1

EXPOSE 6677
EXPOSE 44556/tcp
EXPOSE 44556/udp

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The port is dynamic (HTTP_PORT variable), so the healthcheck uses the
# shell form to read it from the container's environment at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD sh -c 'wget -q -t1 -O- "http://127.0.0.1:${HTTP_PORT}/webui/api/service?method=get_version" | grep -q "\"error\": null"' || exit 1
