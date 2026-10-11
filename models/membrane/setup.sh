#!/usr/bin/env bash
# The membrane's model backstop in WSL: OpenAI Privacy Filter (Apache-2.0), pinned to one revision of the
# official repository, run on the CPU only (the GPU is shared with other local work). Weights, tokenizer and config only.
set -euo pipefail
DIR="$HOME/models-membrane"
REV="7ffa9a043d54d1be65afb281eddf0ffbe629385b"
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d .venv ]; then
  uv venv --python 3.12 .venv
fi
# CPU wheels for torch, so nothing here ever asks for the card.
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cpu "torch>=2.6"
uv pip install --python .venv/bin/python "transformers>=4.57" "huggingface_hub>=0.34" safetensors
.venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
p = snapshot_download(
    "openai/privacy-filter",
    revision="7ffa9a043d54d1be65afb281eddf0ffbe629385b",
    local_dir="privacy-filter",
    allow_patterns=["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "viterbi_calibration.json", "README.md", "model.sig"],
)
print("downloaded to", p)
PY
du -sh privacy-filter
.venv/bin/python -c "import transformers, torch; print('transformers', transformers.__version__, 'torch', torch.__version__, 'cuda', torch.cuda.is_available())"
