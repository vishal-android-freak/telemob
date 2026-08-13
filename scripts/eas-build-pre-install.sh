#!/usr/bin/env bash
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-}" != "ios" ]]; then
  exit 0
fi

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mobile_version="v0.0.0-20260812174124-2f419b2fb945"

if ! command -v go >/dev/null 2>&1; then
  export HOMEBREW_NO_AUTO_UPDATE=1
  brew install go
fi

mkdir -p "${app_dir}/.tools/bin"
export GOBIN="${app_dir}/.tools/bin"
export GOPATH="${app_dir}/.tools/gopath"
export GOMODCACHE="${GOPATH}/pkg/mod"
export GOCACHE="${app_dir}/.tools/go-build"
export PATH="${GOBIN}:${PATH}"

go install "golang.org/x/mobile/cmd/gomobile@${mobile_version}"
go install "golang.org/x/mobile/cmd/gobind@${mobile_version}"

bash "${app_dir}/scripts/build-go-core.sh" ios
