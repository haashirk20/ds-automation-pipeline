#!/bin/bash
# Idempotent setup for Ubuntu 24.04 (arm64 or amd64). Run as root from the repo root,
# with the built binary at ./uploader.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x ./uploader ] || { echo "build ./uploader first (see SPEC.md, VM branch)" >&2; exit 1; }

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg fonts-dejavu-core

id uploader >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin uploader

if [ -z "$(swapon --show --noheadings)" ] && [ ! -e /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 0755 ./uploader /usr/local/bin/uploader
install -m 0644 deploy/uploader.service /etc/systemd/system/uploader.service
created=0
if [ ! -e /etc/uploader.env ]; then
  install -m 0600 -o root -g root deploy/uploader.env.example /etc/uploader.env
  created=1
fi

systemctl daemon-reload
systemctl enable uploader
if [ "$created" = 1 ]; then
  echo "Created /etc/uploader.env. Fill in every value (ADMIN_PASSWORD needs 12+ characters),"
  echo "then run this script again to start the service."
  exit 0
fi
systemctl restart uploader
