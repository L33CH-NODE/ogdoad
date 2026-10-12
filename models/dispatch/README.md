# The dispatcher's local model

Ogdoad's dispatcher (see `docs/ROOMS-AND-THE-MEMBRANE.md`) proposes a lineup for a project room: which hire takes which part of the job, and why. It runs on this machine.

- **Model:** a small Qwen 3.5 (`qwen3.5:4b` by default), served by [llama.cpp](https://github.com/ggml-org/llama.cpp) straight from the file Ollama already keeps, so there's no second copy. `serve.sh` finds the file from Ollama's manifest for the tag.
- **CPU by default.** A GPU shared with other local work is left alone. On a 16-thread budget, a lineup takes about 20 to 30 seconds. Set `DISPATCH_GPU_LAYERS` to use the GPU when it's free.
- **What it reads:**
  - The room's name and brief, as the engine holds them: through the membrane, so stand-ins only.
  - The team: names, harness, cloud or local, role.
  - The parts the room already has.
- **What it returns:** JSON, constrained by a schema, so it's always a list of parts with a hire from the team (or nobody), a reason, and whether the part needs the real records.
- **The rule isn't the model's to keep.** A part that needs the real records goes only to a local hire: the app moves it if the model forgets, and refuses an approval that breaks it.

## Set it up

Install `serve.sh` as `~/models-dispatch/serve.sh` in WSL. It needs a llama.cpp build recent enough to know the model (`qwen35`), and the model pulled in Ollama. Then put it on Horos's roster as an on-demand server, like the membrane's model:

```json
{"harness": "generic", "cwd": "<your Ogdoad home>", "label": "Dispatcher model (WSL)", "command": "wsl",
 "args": ["-d", "Ubuntu", "-u", "<you>", "--", "bash", "/home/<you>/models-dispatch/serve.sh"],
 "role": "server", "onDemand": true, "provides": "dispatch", "health": "http://127.0.0.1:11442/health"}
```

The app wakes it through Horos when the operator asks for a lineup, and it rests when unused. `OGDOAD_DISPATCH_URL=off` turns the dispatcher off.
