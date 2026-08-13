#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
core_dir="${app_dir}/go/teleportmobile"

if [[ -x "${app_dir}/.tools/bin/gomobile" ]]; then
  export PATH="${app_dir}/.tools/bin:${PATH}"
fi
export GOPATH="${TELEMOB_GOPATH:-${app_dir}/.tools/gopath}"
export GOMODCACHE="${TELEMOB_GOMODCACHE:-${GOPATH}/pkg/mod}"
export GOCACHE="${TELEMOB_GOCACHE:-${app_dir}/.tools/go-build}"
if [[ "${TELEMOB_GO_OFFLINE:-0}" == "1" ]]; then
  export GOPROXY=off
  export GOSUMDB=off
fi

# The ChatGPT/Codex project mirror is not itself a Git checkout. Disable Go's
# VCS stamping so generated gomobile work modules build in either environment.
export GOFLAGS="${GOFLAGS:+${GOFLAGS} }-buildvcs=false"

if ! command -v gomobile >/dev/null 2>&1; then
  echo "gomobile is required. Install it with: go install golang.org/x/mobile/cmd/gomobile@latest"
  exit 1
fi

case "${platform}" in
  android)
    mkdir -p "${app_dir}/modules/expo-teleport/android/libs"
    (
      cd "${core_dir}"
      # Telemob's supported Android device is Pixel 10 (arm64-v8a). Keeping
      # the Go binding single-architecture also prevents accidental fat APKs.
      gomobile bind -target=android/arm64 -androidapi 24 \
        -o "${app_dir}/modules/expo-teleport/android/libs/teleportmobile.aar" .
    )
    ;;
  ios)
    mkdir -p "${app_dir}/modules/expo-teleport/ios/Frameworks"
    (
      cd "${core_dir}"
      gomobile bind -target=ios \
        -o "${app_dir}/modules/expo-teleport/ios/Frameworks/Teleportmobile.xcframework" .
    )
    ;;
  *)
    echo "usage: $0 android|ios"
    exit 2
    ;;
esac
