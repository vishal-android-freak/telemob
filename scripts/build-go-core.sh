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
      # The Android App Bundle contains React Native libraries for every
      # supported ABI. Build the Go bridge for the same complete set so Play
      # cannot deliver an otherwise valid split APK without libgojni.so.
      # gomobile's android target includes arm, arm64, 386, and amd64.
      gomobile bind -target=android -androidapi 24 \
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
