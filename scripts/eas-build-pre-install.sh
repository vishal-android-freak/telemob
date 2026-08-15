#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="${EAS_BUILD_PLATFORM:-}"
go_version="1.26.4"
go_linux_amd64_sha256="1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f"
mobile_version="v0.0.0-20260812174124-2f419b2fb945"

case "${platform}" in
  android)
    go_root="${app_dir}/.tools/go"
    if [[ ! -x "${go_root}/bin/go" ]]; then
      archive_name="go${go_version}.linux-amd64.tar.gz"
      archive_path="${app_dir}/.tools/${archive_name}"
      mkdir -p "${app_dir}/.tools"
      curl --fail --location --silent --show-error \
        "https://go.dev/dl/${archive_name}" \
        --output "${archive_path}"
      printf '%s  %s\n' "${go_linux_amd64_sha256}" "${archive_path}" \
        | sha256sum --check -
      tar -C "${app_dir}/.tools" -xzf "${archive_path}"
    fi
    export PATH="${go_root}/bin:${PATH}"
    export GOTOOLCHAIN=local
    ;;
  ios)
    if ! command -v go >/dev/null 2>&1; then
      export HOMEBREW_NO_AUTO_UPDATE=1
      brew install go
    fi
    ;;
  *)
    echo "Skipping gomobile bindings for unsupported EAS platform: ${platform:-unset}"
    exit 0
    ;;
esac

mkdir -p "${app_dir}/.tools/bin"
export GOBIN="${app_dir}/.tools/bin"
export GOPATH="${app_dir}/.tools/gopath"
export GOMODCACHE="${GOPATH}/pkg/mod"
export GOCACHE="${app_dir}/.tools/go-build"
export PATH="${GOBIN}:${PATH}"

go install "golang.org/x/mobile/cmd/gomobile@${mobile_version}"
go install "golang.org/x/mobile/cmd/gobind@${mobile_version}"

bash "${app_dir}/scripts/build-go-core.sh" "${platform}"

if [[ "${platform}" == "android" ]]; then
  bash "${app_dir}/scripts/verify-android-native-libs.sh" \
    "${app_dir}/modules/expo-teleport/android/libs/teleportmobile.aar"
fi
