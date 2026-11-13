#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s BUILD_DIRECTORY\n' "$0" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$1"
# Installed C SPA headers are system includes; keep all authored code Werror.
read -r -a includes <<< "$(pkg-config --cflags-only-I libpipewire-0.3)"
flags=()
for include in "${includes[@]}"; do flags+=(-isystem "${include#-I}"); done
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread "${flags[@]}" \
  "$here/pcm_custody.cc" "$here/local_media_state.cc" "$here/pipewire_output.cc" \
  "$here/test/test_pipewire_output.cc" $(pkg-config --libs libpipewire-0.3) -o "$1/test-pipewire-output"
"$1/test-pipewire-output"
# Compile/link production without running or connecting to system PipeWire.
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread -fPIC -shared -Wl,-z,defs "${flags[@]}" \
  "$here/pcm_custody.cc" "$here/local_media_state.cc" "$here/pipewire_output.cc" \
  $(pkg-config --libs libpipewire-0.3) -o "$1/libmtai-pipewire-check.so"
