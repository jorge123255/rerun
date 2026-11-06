#!/bin/sh
set -eu
python3 /usr/local/lib/rerun/guest.py check-mounts
mkdir -p /var/lib/rerun/profile /run/rerun /home/rerun /tmp/.X11-unix
mkdir -p /home/rerun/workspace /run/rerun/computer-launchers
chmod 700 /home/rerun/workspace /run/rerun/computer-launchers
chmod 1777 /tmp/.X11-unix
exec python3 /usr/local/lib/rerun/guest.py supervise
