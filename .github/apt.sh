#!/bin/sh
# Installs the render tools. The downloaded .debs are kept in ~/apt-debs, which the workflows cache,
# because the runner's Ubuntu mirror is sometimes very slow (one run: 63 MB at 50 kB/s, 21 minutes).
set -eu
d="$HOME/apt-debs"
mkdir -p "$d/partial"
sudo apt-get update -q
sudo apt-get install -y -q --no-install-recommends -o Dir::Cache::Archives="$d" \
  ffmpeg fonts-dejavu-core fonts-montserrat fonts-noto-color-emoji pango1.0-tools
sudo apt-get autoclean -q -o Dir::Cache::Archives="$d"
sudo chown -R "$(id -u):$(id -g)" "$d"
