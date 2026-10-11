# The membrane's local model

The third pass of Ogdoad's membrane (see `docs/ROOMS-AND-THE-MEMBRANE.md`): a local model that finds what may be private in a message that the books and the patterns didn't catch, such as a name nobody entered, an address in passing, or a key pasted by mistake. What it finds is shown to the operator on the check card as possibly sensitive. It never replaces anything by itself.

- **Model:** [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter), Apache-2.0. Pinned to revision `7ffa9a043d54d1be65afb281eddf0ffbe629385b`. Use only the official `openai/privacy-filter` repository: copies with similar names have carried malware.
  - 1.5B parameters, 50M active, so it runs on the CPU in about 100 to 160 ms per message. The GPU is left alone.
  - 8 kinds: people, addresses, emails, phones, account numbers, private links, dates, secrets.
- **Where:** WSL (Linux), in `~/models-membrane`, listening on `127.0.0.1:11441`. Windows reaches it through WSL's localhost forwarding.
- **What the service adds to the model:**
  - It joins spans split mid-word and stretches each to whole words.
  - It drops the hires' own names (sent as `protect`).
  - It keeps a date only when it carries a year at least ten years back (a birthday, not a deadline).
  - It never logs a text, a span or a name: only counts and timings.

## Set it up

```sh
bash setup.sh        # a CPU-only venv, the pinned model files (about 2.7 GB)
cp serve.py ~/models-membrane/serve.py
```

Then put it on Horos's roster as an on-demand server, like Ollama, so it starts when needed and rests when unused (the WSL VM can sleep). Use your own WSL user and Windows home:

```json
{"harness": "generic", "cwd": "<your Ogdoad home>", "label": "Membrane model (WSL)", "command": "wsl",
 "args": ["-d", "Ubuntu", "-u", "<you>", "--", "/home/<you>/models-membrane/.venv/bin/python", "-I", "/home/<you>/models-membrane/serve.py"],
 "role": "server", "onDemand": true, "provides": "membrane", "health": "http://127.0.0.1:11441/health"}
```

POST that to Horos's `/v1/hires`.
- **When it's resting:** the app wakes it through Horos. That happens while the operator types, or at the latest when a message is sent; a cold start takes about 10 seconds.
- **Turning it off:** set `OGDOAD_BACKSTOP_URL=off` for the app. Without the model, the books and the patterns still check everything.
