#!/usr/bin/env bash
set -euo pipefail

release_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir="${1:-${APP_DIR:-/home/azureuser/khaoyai304-backend}}"
if [[ ! -f "$app_dir/package.json" ]]; then
  echo "Backend not found at $app_dir. Pass its path as the first argument." >&2
  exit 1
fi

backup_dir="${app_dir%/}-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir/src/functions" "$backup_dir/src/khaoyai"
for path in src/functions/projectApi.js src/functions/uploadApi.js src/khaoyai sql; do
  [[ -e "$app_dir/$path" ]] && cp -a "$app_dir/$path" "$backup_dir/$path"
done

mkdir -p "$app_dir/src/functions" "$app_dir/src/khaoyai" "$app_dir/sql"
cp "$release_dir/src/functions/projectApi.js" "$release_dir/src/functions/uploadApi.js" "$app_dir/src/functions/"
cp "$release_dir"/src/khaoyai/*.js "$app_dir/src/khaoyai/"
cp "$release_dir"/sql/*.sql "$app_dir/sql/"
cd "$app_dir"
npm install --omit=dev

if command -v pm2 >/dev/null 2>&1 && pm2 describe khaoyai304-backend >/dev/null 2>&1; then
  pm2 restart khaoyai304-backend --update-env
elif [[ -n "${SERVICE_NAME:-}" ]]; then
  sudo systemctl restart "$SERVICE_NAME"
else
  echo "Files installed. Restart the existing Functions host manually (or set SERVICE_NAME)."
fi
echo "Backup: $backup_dir"
