#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="${1:-${app_dir}/modules/expo-teleport/android/libs/teleportmobile.aar}"

if [[ ! -f "${artifact}" ]]; then
  echo "Android artifact not found: ${artifact}" >&2
  exit 1
fi

case "${artifact}" in
  *.aar) library_root="jni"; require_terminal=false; require_all_abis=true ;;
  *.aab) library_root="base/lib"; require_terminal=true; require_all_abis=true ;;
  *.apk) library_root="lib"; require_terminal=true; require_all_abis=false ;;
  *)
    echo "Expected an Android .aar, .aab, or .apk artifact: ${artifact}" >&2
    exit 1
    ;;
esac

for tool in unzip readelf; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} is required to verify Android native libraries." >&2
    exit 1
  fi
done

analysis_dir="$(mktemp -d)"
trap 'rm -rf -- "${analysis_dir}"' EXIT
unzip -q "${artifact}" "${library_root}/*/*.so" -d "${analysis_dir}"

if [[ "${require_all_abis}" == true ]]; then
  required_abis=(armeabi-v7a arm64-v8a x86 x86_64)
else
  mapfile -t required_abis < <(
    find "${analysis_dir}/${library_root}" -mindepth 1 -maxdepth 1 -type d \
      -printf '%f\n' | sort
  )
  if [[ "${#required_abis[@]}" -eq 0 ]]; then
    echo "No Android native-library ABIs found in ${artifact}" >&2
    exit 1
  fi
fi

for abi in "${required_abis[@]}"; do
  go_library="${analysis_dir}/${library_root}/${abi}/libgojni.so"
  if [[ ! -f "${go_library}" ]]; then
    echo "Missing Go bridge for Android ABI ${abi}: ${library_root}/${abi}/libgojni.so" >&2
    exit 1
  fi
  if [[ "${require_terminal}" == true ]]; then
    terminal_library="${analysis_dir}/${library_root}/${abi}/libtelemob_terminal_jni.so"
    if [[ ! -f "${terminal_library}" ]]; then
      echo "Missing Ghostty terminal JNI for Android ABI ${abi}: ${library_root}/${abi}/libtelemob_terminal_jni.so" >&2
      exit 1
    fi
  fi
done

for abi in "${required_abis[@]}"; do
  [[ "${abi}" == arm64-v8a || "${abi}" == x86_64 ]] || continue
  while IFS= read -r library; do
    mapfile -t alignments < <(
      readelf -lW "${library}" | awk '$1 == "LOAD" { print $NF }' | sort -u
    )

    if [[ "${#alignments[@]}" -eq 0 ]]; then
      echo "No ELF LOAD segments found in ${library}" >&2
      exit 1
    fi

    for alignment in "${alignments[@]}"; do
      if (( alignment < 0x4000 )); then
        echo "16 KB alignment failure: ${abi}/$(basename "${library}") uses ${alignment}" >&2
        exit 1
      fi
    done
  done < <(find "${analysis_dir}/${library_root}/${abi}" -type f -name '*.so' -print | sort)
done

if [[ "${require_terminal}" == true ]]; then
  echo "Verified matching Android Go and Ghostty terminal ABIs plus 16 KB alignment."
else
  echo "Verified all Android Go ABIs and 16 KB alignment for arm64-v8a and x86_64."
fi
