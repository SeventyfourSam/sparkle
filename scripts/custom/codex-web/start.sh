#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$script_dir/runtime/node" ]; then
  node_bin="$script_dir/runtime/node"
else
  node_bin=node
fi
exec "$node_bin" "$script_dir/server.cjs" "$@"
