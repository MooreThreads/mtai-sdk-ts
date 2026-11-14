#!/usr/bin/env bash
# Production N-API addon only. Loading this module does not initialize media.
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s OUTPUT.node\n' "$0" >&2; exit 2; fi
[[ $(uname -s) == Linux && $(uname -m) == aarch64 ]] || { printf 'Avatar addon requires Linux ARM64\n' >&2; exit 1; }
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$(dirname -- "$1")"
flags=(-isystem "${NODE_INCLUDE_DIR:-/usr/include/node}")
read -r -a includes <<< "$(pkg-config --cflags-only-I libpipewire-0.3)"
for include in "${includes[@]}"; do flags+=(-isystem "${include#-I}"); done
sources=(local_media_protocol local_media_state pcm_custody pipewire_output async_playback node_playback local_media_transport local_media_connection node_connection)
inputs=(); for source in "${sources[@]}"; do inputs+=("$here/$source.cc"); done
"${CXX:-g++}" -std=c++17 -O2 -Wall -Wextra -Werror -pthread -fPIC -shared -DNAPI_VERSION=8 \
  "${flags[@]}" "${inputs[@]}" $(pkg-config --libs libpipewire-0.3) "${UV_LIBRARY:--l:libuv.so.1}" -o "$1"
