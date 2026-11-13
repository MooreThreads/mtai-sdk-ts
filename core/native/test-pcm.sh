#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s BUILD_DIRECTORY\n' "$0" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$1"
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread \
  "$here/pcm_custody.cc" "$here/test/test_pcm_custody.cc" -o "$1/test-pcm-custody"
"$1/test-pcm-custody"
