#!/bin/sh
set -eu
python3 /usr/local/lib/rerun/guest.py check-mounts
mkdir -p /var/lib/rerun/profile /run/rerun /home/rerun /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
exec python3 /usr/local/lib/rerun/guest.py supervise
