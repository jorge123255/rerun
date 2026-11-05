#!/bin/sh
# Root only long enough to reject a bad mount and hand the profile volume to rerun.
set -eu
python3 /usr/local/lib/rerun/guest.py check-mounts
mkdir -p /var/lib/rerun/profile /run/rerun /home/rerun /tmp/.X11-unix
chown rerun:rerun /var/lib/rerun/profile /run/rerun /home/rerun
chmod 1777 /tmp /tmp/.X11-unix
exec setpriv --reuid=rerun --regid=rerun --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- python3 /usr/local/lib/rerun/guest.py supervise
