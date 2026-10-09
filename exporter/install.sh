#!/usr/bin/env bash
# Install the Nautilus icon exporter as a systemd USER timer (no root needed).
# Run as the desktop user whose Nautilus customizations should appear in HFS:
#   ./exporter/install.sh
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="${HOME}/.config/systemd/user"
CACHE_DIR="${HFS_EXPORT_CACHE:-/var/tmp/hfs-directory}"

mkdir -p "${UNIT_DIR}" "${CACHE_DIR}"
chmod 755 "${CACHE_DIR}"

sed -e "s|@PLUGIN_DIR@|${PLUGIN_DIR}|g" -e "s|@NODE@|${NODE_BIN}|g" \
    "${PLUGIN_DIR}/exporter/hfs-directory-export.service" > "${UNIT_DIR}/hfs-directory-export.service"
cp -a "${PLUGIN_DIR}/exporter/hfs-directory-export.timer" "${UNIT_DIR}/hfs-directory-export.timer"

systemctl --user daemon-reload
systemctl --user enable --now hfs-directory-export.timer
systemctl --user start hfs-directory-export.service || true

echo "Exporter installed. Cache: ${CACHE_DIR}"
echo "Check with: systemctl --user status hfs-directory-export.service"
echo "For run-at-boot without login, ask an admin to run: loginctl enable-linger ${USER}"
