#!/usr/bin/env bash
set -euo pipefail

zip_url="${1:?Usage: deploy-from-storage.sh ZIP_URL [APP_DIR]}"
app_dir="${2:-${APP_DIR:-/home/azureuser/khaoyai304-backend}}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 "$zip_url" --output "$work_dir/release.zip"
unzip -q "$work_dir/release.zip" -d "$work_dir/release"
bash "$work_dir/release/install-on-vm.sh" "$app_dir"
