#!/usr/bin/env bash
# Make this machine's journald persistent, so container logs survive reboots,
# container recreation, and `docker compose down`.
#
# DietPi ships Storage=auto with /var/log/journal absent, which means the
# journal lives only in /run/journal (RAM, 512MB cap, wiped at boot). That is
# why SearXNG logs older than "since the last boot" are unrecoverable.
#
# Safe and idempotent: touches no container, no settings, no data volume.
# Run as root on the SearXNG host:  sudo ./journal-persist.sh
set -euo pipefail

DROP_IN_DIR=/etc/systemd/journald.conf.d
DROP_IN=$DROP_IN_DIR/90-searxng-retention.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

echo "== before =="
journalctl --disk-usage 2>/dev/null || true
ls -ld /var/log/journal 2>/dev/null || echo "/var/log/journal: absent (volatile journal)"

install -d /var/log/journal
install -d "$DROP_IN_DIR"
cat > "$DROP_IN" <<'EOF'
# Added by pi-web-tools/ops/searxng: keep container logs across boots.
# `journalctl CONTAINER_NAME=searxng` reads from here.
[Journal]
Storage=persistent
# Hard ceiling so retention can never fill the disk.
SystemMaxUse=1G
SystemMaxFileSize=100M
SystemMaxFiles=20
# One journal file per week: cheap to archive, cheap to prune.
MaxFileSec=1week
EOF

# A running service with its own limits (DietPi tunes these sometimes) is not
# overridden here; say so rather than pretending.
if grep -qs '^\s*Storage=' /etc/systemd/journald.conf; then
  echo "note: /etc/systemd/journald.conf already sets Storage= — drop-in wins (journald.conf.d), verify below"
fi

# Push the RAM journal out to disk before restarting, then rotate to bound it.
journalctl --flush || true
journalctl --rotate || true
systemctl restart systemd-journald

echo
echo "== after =="
ls -ld /var/log/journal
journalctl --disk-usage
echo
echo "searxng journal coverage now available:"
journalctl CONTAINER_NAME=searxng --no-pager -n 1 -o short-iso 2>/dev/null || echo "  (no searxng entries found)"
journalctl CONTAINER_NAME=searxng --no-pager -n 1 -o short-iso --since "1 year ago" 2>/dev/null | head -1 || true
echo
echo "Retention note: SystemMaxUse is the hard ceiling, but on this DietPi host"
echo "the hourly dietpi-logclear truncates every file under /var/log - journal"
echo "storage included - so the journal keeps only ~1 hour of lines. The harvest"
echo "on a schedule (harvest.sh, every 15 min) is what actually preserves them."
