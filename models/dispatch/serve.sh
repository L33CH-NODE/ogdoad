#!/usr/bin/env bash
# The dispatcher's local model for Ogdoad: a small Qwen 3.5 served by llama.cpp, on the CPU by default
# (a GPU shared with other local work is left alone). It reads a job (stand-ins only, never real names)
# and the team, and proposes who does which part; the operator approves or denies the lineup.
#
# It serves the model file Ollama already keeps (no second copy): DISPATCH_MODEL names the tag.
# Listens on this machine only.
set -euo pipefail
TAG="${DISPATCH_MODEL:-qwen3.5:4b}"
PORT="${DISPATCH_PORT:-11442}"
LLAMA="${LLAMA_SERVER:-$HOME/llama.cpp/build/bin/llama-server}"
STORE="${OLLAMA_MODELS:-$HOME/.ollama/models}"
NAME="${TAG%%:*}"
VERSION="${TAG#*:}"
MANIFEST="$STORE/manifests/registry.ollama.ai/library/$NAME/$VERSION"
DIGEST=$(python3 -c 'import json, sys; m = json.load(open(sys.argv[1])); print([l for l in m["layers"] if l["mediaType"] == "application/vnd.ollama.image.model"][0]["digest"].replace(":", "-"))' "$MANIFEST")
exec "$LLAMA" -m "$STORE/blobs/$DIGEST" --host 127.0.0.1 --port "$PORT" -ngl "${DISPATCH_GPU_LAYERS:-0}" -c 8192 -t "${DISPATCH_THREADS:-16}" --jinja
