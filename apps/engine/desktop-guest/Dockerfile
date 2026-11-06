# Isolated coworker screen. This is not the engine image in apps/engine/Dockerfile:
# no engine bundle or Codex/Claude CLI; Terminal and Files stay inside this guest.
# Root builds it for the Mac's Docker engine. This lane does not build or run it.
#   docker build --platform linux/arm64 -t rerun-desktop-guest:round33 -f apps/engine/desktop-guest/Dockerfile apps/engine/desktop-guest
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-liberation \
        openbox \
        python3 \
        npm \
        util-linux \
        x11vnc \
        xdotool \
        x11-utils \
        thunar \
        xfce4-terminal \
        xvfb \
        maim \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh --uid 10001 rerun \
    && mkdir -p /var/lib/rerun/profile /usr/local/lib/rerun /usr/local/share/rerun \
    && chown -R rerun:rerun /var/lib/rerun

COPY openbox.xml /usr/local/share/rerun/openbox.xml
COPY guest.py /usr/local/lib/rerun/guest.py
COPY tool_install.py /usr/local/lib/rerun/tool_install.py
COPY computer_launchers.py /usr/local/lib/rerun/computer_launchers.py
COPY entrypoint.sh /usr/local/bin/rerun-entrypoint
COPY rerun-rpc /usr/local/bin/rerun-rpc
COPY rerun-vnc /usr/local/bin/rerun-vnc

RUN chmod 755 /usr/local/bin/rerun-entrypoint /usr/local/bin/rerun-rpc /usr/local/bin/rerun-vnc \
    && chmod 644 /usr/local/lib/rerun/guest.py /usr/local/lib/rerun/computer_launchers.py /usr/local/lib/rerun/tool_install.py /usr/local/share/rerun/openbox.xml \
    && test -x /usr/bin/npm && test -x /usr/bin/thunar && test -x /usr/bin/xfce4-terminal && test -x /usr/bin/xprop

VOLUME /var/lib/rerun/profile

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/rerun-entrypoint"]
