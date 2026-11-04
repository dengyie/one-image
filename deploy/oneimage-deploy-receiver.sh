#!/usr/bin/env bash
set -euo pipefail

root=/personal/pxed/oneimage
release_root="$root/releases"
incoming="$root/incoming"
current="$root/current"
supervisor_ctl="supervisorctl -c /personal/pxed/supervisord.conf"
health_url="http://127.0.0.1:8877/healthz"
capabilities_url="http://127.0.0.1:8877/api/v1/capabilities"

sha=''
archive=''
checksum=''

# GitHub Actions uses a forced-command SSH key. In that mode sshd does not
# pass argv; it exposes the requested command through SSH_ORIGINAL_COMMAND.
if [ "$#" -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Accept only the two CI release streams. The forced key cannot open a
  # shell, SFTP subsystem, arbitrary path, or arbitrary command.
  case "$SSH_ORIGINAL_COMMAND" in
    upload\ *\ archive|upload\ *\ checksum)
      read -r action upload_sha upload_kind extra <<< "$SSH_ORIGINAL_COMMAND"
      case "$upload_sha" in ''|*[!0-9a-f]*) echo "invalid upload sha" >&2; exit 2 ;; esac
      test "${#upload_sha}" -eq 40
      test -z "${extra:-}"
      case "$upload_kind" in
        archive) upload_path="/tmp/oneimage-${upload_sha}.tar.gz" ;;
        checksum) upload_path="/tmp/oneimage-${upload_sha}.tar.gz.sha256" ;;
        *) echo "invalid upload kind" >&2; exit 2 ;;
      esac
      umask 077
      cat > "$upload_path"
      test -s "$upload_path"
      exit 0
      ;;
  esac
  read -r -a original_args <<< "$SSH_ORIGINAL_COMMAND"
  if [ "${#original_args[@]}" -ne 7 ] || [ "${original_args[0]}" != "/usr/local/sbin/oneimage-deploy" ]; then
    echo "invalid forced command" >&2
    exit 2
  fi
  original_args[2]=${original_args[2]#\'}
  original_args[2]=${original_args[2]%\'}
  original_args[4]=${original_args[4]#\'}
  original_args[4]=${original_args[4]%\'}
  original_args[6]=${original_args[6]#\'}
  original_args[6]=${original_args[6]%\'}
  set -- "${original_args[@]:1}"
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) sha=${2:?missing --sha value}; shift 2 ;;
    --archive) archive=${2:?missing --archive value}; shift 2 ;;
    --checksum) checksum=${2:?missing --checksum value}; shift 2 ;;
    *) echo "unknown argument" >&2; exit 2 ;;
  esac
done
case "$sha" in
  ''|*[!0-9a-f]*) echo "invalid release sha" >&2; exit 2 ;;
esac
test "${#sha}" -eq 40
case "$archive" in /tmp/oneimage-*.tar.gz) ;; *) echo "archive must be a CI /tmp release" >&2; exit 2 ;; esac
case "$checksum" in /tmp/oneimage-*.tar.gz.sha256) ;; *) echo "checksum must be a CI /tmp release" >&2; exit 2 ;; esac
test "$(basename "$archive").sha256" = "$(basename "$checksum")"
test -f "$archive"
test -f "$checksum"
grep -F "  $(basename "$archive")" "$checksum" >/dev/null
(cd /tmp && sha256sum -c "$(basename "$checksum")")

mkdir -p "$release_root" "$incoming"
stage=$(mktemp -d "$incoming/${sha}.XXXXXX")
rollback=''
cleanup() { rm -rf "$stage"; rm -f "$root/run.sh.new" "$current.new"; }
trap cleanup EXIT
while IFS= read -r entry; do
  case "$entry" in
    ''|\./) ;;
    /*|../*|*/../*|*/..|*\\*) echo "unsafe archive entry: $entry" >&2; exit 1 ;;
  esac
done < <(tar -tzf "$archive")
tar -xzf "$archive" -C "$stage"
test "$(cat "$stage/REVISION")" = "$sha"
test -s "$stage/dist/index.html"
test -s "$stage/index.cjs"
test -s "$stage/package.json"
test -s "$stage/package-lock.json"
chmod +x "$stage/run.sh"
chmod 0711 "$root" "$release_root" "$incoming" "$stage" "$stage/dist" "$stage/dist/assets"
find "$stage/dist" -type f -exec chmod 0644 {} +
# The release archive ships a production node_modules built on the CI runner
# (see the package job), so the constrained host never runs an install. Only
# older archives without it fall back to a host npm ci.
if [ -d "$stage/node_modules" ]; then
  echo "release ships node_modules; skipping host npm ci"
else
  cd "$stage"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  cd - >/dev/null
fi

release="$release_root/$sha"
if [ -e "$release" ]; then
  rm -rf "$stage"
else
  mv "$stage" "$release"
fi
test -s "$release/run.sh"
# Keep the host Supervisor entrypoint tied to the exact release being started.
# The release root is on NFS and writing a second file in its quota-limited
# parent can fail at close(2), so use an atomic symlink to the validated file.
rm -f "$root/run.sh.new"
ln -s "$release/run.sh" "$root/run.sh.new"
mv -Tf "$root/run.sh.new" "$root/run.sh"
if [ -L "$current" ]; then rollback=$(readlink "$current"); fi
rm -f "$current.new"
ln -s "$release" "$current.new"
mv -Tf "$current.new" "$current"

rollback_current() {
  if [ -n "$rollback" ]; then
    rm -f "$current.new"
    ln -s "$rollback" "$current.new"
    mv -Tf "$current.new" "$current"
  else
    rm -f "$current"
  fi
  if [ -n "$rollback" ] && [ -s "$rollback/run.sh" ]; then
    rm -f "$root/run.sh.new"
    ln -s "$rollback/run.sh" "$root/run.sh.new"
    mv -Tf "$root/run.sh.new" "$root/run.sh"
  fi
  $supervisor_ctl restart oneimage || true
}

if ! $supervisor_ctl restart oneimage; then
  rollback_current
  exit 1
fi
# This host keeps `proxy=http://127.0.0.1:7897` in /root/.curlrc, so every plain
# curl here — including these loopback probes — is sent through the shared proxy
# that all other services on the box also use. Under load that leg adds seconds
# (measured 0.2-0.3s idle, >5s congested) on top of a loopback round trip that
# is really ~1ms, which is enough to make a healthy release look dead. The app
# is on 127.0.0.1, so bypass the proxy explicitly and keep the probe honest.
curl_probe() { curl --noproxy '*' "$@"; }
# A cold start on this host can take several seconds before the first HTTP
# response lands (NFS-backed bundle + SQLite open), so a single short probe is
# guaranteed to misjudge a healthy release. Probe with a bounded retry budget
# instead, and still fail closed (rollback) when the app never becomes healthy.
health_code=''
for attempt in $(seq 1 20); do
  health_code=$(curl_probe --silent --max-time 10 -o /tmp/oneimage-health.json -w '%{http_code}' "$health_url" 2>/dev/null) || health_code=''
  if [ "$health_code" = 200 ] || [ "$health_code" = 503 ]; then
    grep -Eq '"status":"(ok|degraded)"' /tmp/oneimage-health.json 2>/dev/null && break
  fi
  [ "$attempt" -lt 20 ] && sleep 2
done
case "$health_code" in 200|503) ;; *) rollback_current; exit 1 ;; esac
grep -Eq '"status":"(ok|degraded)"' /tmp/oneimage-health.json || { rollback_current; exit 1; }
capabilities_ok=''
for attempt in $(seq 1 10); do
  if curl_probe --fail --silent --show-error --max-time 5 "$capabilities_url" >/tmp/oneimage-capabilities.json 2>/dev/null \
    && grep -q '"maxInputBytes"' /tmp/oneimage-capabilities.json; then
    capabilities_ok=1
    break
  fi
  [ "$attempt" -lt 10 ] && sleep 2
done
if [ -z "$capabilities_ok" ]; then
  rollback_current
  exit 1
fi
rm -f "$archive" "$checksum"
active_release=$(readlink -f "$current" 2>/dev/null || true)
active_entrypoint=$(readlink -f "$root/run.sh" 2>/dev/null || true)
find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr | tail -n +4 | cut -d' ' -f2- \
  | while IFS= read -r candidate; do
      [ "$candidate" = "$active_release" ] && continue
      [ "$candidate" = "${active_entrypoint%/run.sh}" ] && continue
      rm -rf "$candidate"
    done
printf 'deployed %s\n' "$sha"
