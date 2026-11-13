#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s BUILD_DIRECTORY\n' "$0" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$1"
# Node development headers expose the system libuv ABI on this build host.
# Override header/link inputs for other Linux development installations.
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread \
  -I"${UV_INCLUDE_DIR:-/usr/include/node}" \
  "$here/local_media_protocol.cc" "$here/local_media_transport.cc" \
  "$here/local_media_state.cc" "$here/local_media_connection.cc" \
  "$here/test/test_local_media_connection.cc" \
  -Wl,--wrap=clock_gettime "${UV_LIBRARY:--l:libuv.so.1}" -o "$1/test-local-media-connection"
"$1/test-local-media-connection"
