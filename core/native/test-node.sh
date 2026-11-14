#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s BUILD_DIRECTORY\n' "$0" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$1"
flags=(-isystem "${NODE_INCLUDE_DIR:-/usr/include/node}")
read -r -a includes <<< "$(pkg-config --cflags-only-I libpipewire-0.3)"
for include in "${includes[@]}"; do flags+=(-isystem "${include#-I}"); done
sources=("$here/local_media_protocol.cc" "$here/local_media_state.cc" "$here/pcm_custody.cc" "$here/pipewire_output.cc" "$here/async_playback.cc" "$here/node_playback.cc")
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread -fPIC -shared -DNAPI_VERSION=8 "${flags[@]}" \
  "${sources[@]}" $(pkg-config --libs libpipewire-0.3) "${UV_LIBRARY:--l:libuv.so.1}" -o "$1/mtai-avatar.node"
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread -fPIC -shared -Wl,-Bsymbolic-functions -DNAPI_VERSION=8 -DMTAI_PIPEWIRE_NODE_FIXTURE "${flags[@]}" \
  "${sources[@]}" "$here/test/test_pipewire_output.cc" $(pkg-config --libs libpipewire-0.3) "${UV_LIBRARY:--l:libuv.so.1}" -o "$1/mtai-avatar-test.node"
node --expose-gc "$here/test/test_node_playback.cjs" "$1/mtai-avatar-test.node"
