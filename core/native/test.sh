#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s BUILD_DIRECTORY\n' "$0" >&2; exit 2; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$1"
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread \
  "$here/test/test_playback_clock.cc" -o "$1/test-playback-clock"
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pthread \
  "$here/local_media_protocol.cc" "$here/local_media_transport.cc" \
  "$here/local_media_state.cc" "$here/test/test_local_media.cc" -o "$1/test-local-media"
"$1/test-playback-clock"
"$1/test-local-media"
python3 "$here/test/interop.py" "$1/test-local-media" \
  "$here/../src/voice/fixtures/local-media-v1.json"
