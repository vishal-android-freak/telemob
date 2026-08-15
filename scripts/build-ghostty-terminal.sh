#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="${1:-}"

ghostty_revision="a746d0f7281954eb251915f4cd9fcea4924ad999"
zig_version="0.15.2"

tools_dir="${app_dir}/.tools"
zig_dir="${tools_dir}/zig"
ghostty_dir="${tools_dir}/ghostty-${ghostty_revision}"
global_cache_dir="${tools_dir}/zig-global-cache"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    zig_archive="zig-x86_64-linux-${zig_version}.tar.xz"
    zig_sha256="02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"
    ;;
  Darwin-arm64)
    zig_archive="zig-aarch64-macos-${zig_version}.tar.xz"
    zig_sha256="3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b"
    ;;
  Darwin-x86_64)
    zig_archive="zig-x86_64-macos-${zig_version}.tar.xz"
    zig_sha256="375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f"
    ;;
  *)
    echo "Unsupported Ghostty build host: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "${tools_dir}" "${global_cache_dir}"

if [[ ! -x "${zig_dir}/zig" ]] || [[ "$("${zig_dir}/zig" version 2>/dev/null || true)" != "${zig_version}" ]]; then
  archive_path="${tools_dir}/${zig_archive}"
  unpack_dir="$(mktemp -d "${TMPDIR:-/tmp}/telemob-zig.XXXXXX")"
  trap 'rm -rf "${unpack_dir}"' EXIT

  curl --fail --location --silent --show-error \
    "https://ziglang.org/download/${zig_version}/${zig_archive}" \
    --output "${archive_path}"

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${zig_sha256}" "${archive_path}" | sha256sum --check -
  else
    [[ "$(shasum -a 256 "${archive_path}" | awk '{print $1}')" == "${zig_sha256}" ]]
  fi

  tar -C "${unpack_dir}" -xf "${archive_path}"
  rm -rf "${zig_dir}"
  mv "${unpack_dir}/${zig_archive%.tar.xz}" "${zig_dir}"
  rm -f "${archive_path}"
  trap - EXIT
  rmdir "${unpack_dir}"
fi

zig="${zig_dir}/zig"

if [[ ! -d "${ghostty_dir}/.git" ]]; then
  rm -rf "${ghostty_dir}"
  git init --quiet "${ghostty_dir}"
  git -C "${ghostty_dir}" remote add origin https://github.com/ghostty-org/ghostty.git
  git -C "${ghostty_dir}" fetch --quiet --depth 1 origin "${ghostty_revision}"
  git -C "${ghostty_dir}" checkout --quiet --detach FETCH_HEAD
fi

actual_revision="$(git -C "${ghostty_dir}" rev-parse HEAD)"
if [[ "${actual_revision}" != "${ghostty_revision}" ]]; then
  echo "Ghostty checkout mismatch: expected ${ghostty_revision}, found ${actual_revision}" >&2
  exit 1
fi

# Some build workers cannot establish TLS with Zig's HTTP client even though
# system curl works. Retry a failed build after placing the exact immutable
# dependency archive in Zig's content-addressed cache.
run_zig_build() {
  local local_cache_dir="$1"
  shift
  local log_file
  local status
  local dependency_url
  local dependency_archive
  local dependency_extension

  log_file="$(mktemp "${TMPDIR:-/tmp}/telemob-ghostty-build.XXXXXX")"
  for _ in 1 2 3 4 5; do
    set +e
    ZIG_GLOBAL_CACHE_DIR="${global_cache_dir}" \
      ZIG_LOCAL_CACHE_DIR="${local_cache_dir}" \
      "${zig}" build "$@" 2>&1 | tee "${log_file}"
    status="${PIPESTATUS[0]}"
    set -e

    if [[ "${status}" -eq 0 ]]; then
      rm -f "${log_file}"
      return 0
    fi

    dependency_url="$(sed -n 's/.*\.url = "\(https:\/\/[^\"]*\)".*/\1/p' "${log_file}" | tail -1)"
    if [[ -z "${dependency_url}" ]]; then
      rm -f "${log_file}"
      return "${status}"
    fi

    case "${dependency_url}" in
      *.tar.gz) dependency_extension=".tar.gz" ;;
      *.tar.xz) dependency_extension=".tar.xz" ;;
      *.tar.zst) dependency_extension=".tar.zst" ;;
      *.tgz) dependency_extension=".tgz" ;;
      *.zip) dependency_extension=".zip" ;;
      *) dependency_extension=".tar" ;;
    esac
    dependency_archive="$(mktemp "${TMPDIR:-/tmp}/telemob-ghostty-dependency.XXXXXX${dependency_extension}")"
    curl --fail --location --silent --show-error \
      "${dependency_url}" --output "${dependency_archive}"
    "${zig}" fetch --global-cache-dir "${global_cache_dir}" "${dependency_archive}"
    rm -f "${dependency_archive}"
  done

  rm -f "${log_file}"
  return 1
}

case "${platform}" in
  android)
    ndk_home="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
    if [[ -z "${ndk_home}" ]] && [[ -n "${ANDROID_HOME:-}" ]] && [[ -d "${ANDROID_HOME}/ndk" ]]; then
      ndk_home="$(find "${ANDROID_HOME}/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
    fi
    if [[ -z "${ndk_home}" ]] || [[ ! -d "${ndk_home}/toolchains/llvm" ]]; then
      echo "ANDROID_NDK_HOME must point to an installed Android NDK." >&2
      exit 1
    fi
    export ANDROID_NDK_HOME="${ndk_home}"

    requested_abis="${TELEMOB_ANDROID_ABIS:-arm64-v8a,armeabi-v7a,x86,x86_64}"
    IFS=',' read -r -a abis <<< "${requested_abis}"
    for abi in "${abis[@]}"; do
      case "${abi}" in
        arm64-v8a) target="aarch64-linux-android.24" ;;
        armeabi-v7a) target="arm-linux-androideabi.24" ;;
        x86) target="x86-linux-android.24" ;;
        x86_64) target="x86_64-linux-android.24" ;;
        *) echo "Unsupported Android ABI: ${abi}" >&2; exit 1 ;;
      esac

      output_dir="${app_dir}/modules/expo-teleport/native/ghostty/android/${abi}"
      local_cache_dir="${tools_dir}/zig-local-cache/ghostty-android-${abi}"
      rm -rf "${output_dir}"
      mkdir -p "${output_dir}" "${local_cache_dir}"
      (
        cd "${ghostty_dir}"
        run_zig_build "${local_cache_dir}" \
          -Demit-lib-vt=true \
          -Dtarget="${target}" \
          -Doptimize=ReleaseFast \
          --prefix "${output_dir}"
      )
    done
    ;;
  ios)
    if [[ "$(uname -s)" != "Darwin" ]]; then
      echo "The iOS Ghostty XCFramework must be built on macOS." >&2
      exit 1
    fi

    output_dir="${app_dir}/modules/expo-teleport/ios/Frameworks"
    build_prefix="${tools_dir}/ghostty-ios-prefix"
    local_cache_dir="${tools_dir}/zig-local-cache/ghostty-ios"
    mkdir -p "${output_dir}" "${local_cache_dir}"
    rm -rf "${output_dir}/ghostty-vt.xcframework"
    rm -rf "${build_prefix}"
    mkdir -p "${build_prefix}"
    (
      cd "${ghostty_dir}"
      run_zig_build "${local_cache_dir}" \
        -Demit-lib-vt=true \
        -Demit-xcframework=true \
        -Doptimize=ReleaseFast \
        --prefix "${build_prefix}"
    )
    mv "${build_prefix}/lib/ghostty-vt.xcframework" "${output_dir}/"
    ;;
  *)
    echo "Usage: $0 android|ios" >&2
    exit 1
    ;;
esac
