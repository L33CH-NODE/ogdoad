"""The membrane's model backstop for Ogdoad: OpenAI Privacy Filter (Apache-2.0) on the CPU.

POST /scan {"text": "...", "protect": ["Ledger", ...]} -> {"spans": [{"label", "start", "end", "text", "score"}]}
GET  /health -> {"ok": true, ...}

It finds what may be private in a text that Ogdoad's own passes (the books, the patterns) didn't
replace: a name the books don't know, an address, a secret. Ogdoad shows what it finds to the
operator as "possibly sensitive"; nothing here replaces anything.

Never logs a text, a span or a name: only counts and timings. Listens on this machine only.
"""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import pipeline

HOST = os.environ.get("MEMBRANE_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEMBRANE_PORT", "11441"))
MODEL = os.environ.get("MEMBRANE_MODEL", os.path.expanduser("~/models-membrane/privacy-filter"))
REVISION = "7ffa9a043d54d1be65afb281eddf0ffbe629385b"
MAX_CHARS = 40_000
# Dates are everywhere in business talk ("by Friday 14"); only a confident one (a birthday) counts.
MIN_SCORE = {"private_date": 0.9}
DEFAULT_MIN = 0.6

torch.set_num_threads(int(os.environ.get("MEMBRANE_THREADS", "4")))
started = time.time()
clf = pipeline(task="token-classification", model=MODEL, aggregation_strategy="simple", device=-1)
lock = threading.Lock()
WORD = re.compile(r"[\w'’-]")


def log(msg):
    print(f"[membrane {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def spans_of(text, protect):
    with lock:
        raw = clf(text)
    # The tokenizer splits words, and the spans come back in pieces ("Priya Okonk" + "wo"): join the
    # pieces of one label that touch, then stretch each span to whole words.
    merged = []
    for o in sorted(raw, key=lambda o: o["start"]):
        label, start, end, score = o["entity_group"], int(o["start"]), int(o["end"]), float(o["score"])
        if merged and merged[-1]["label"] == label and start - merged[-1]["end"] <= 1 and not text[merged[-1]["end"]:start].strip(" .,"):
            m = merged[-1]
            m["end"], m["score"] = end, min(m["score"], score)
        else:
            merged.append({"label": label, "start": start, "end": end, "score": score})
    out = []
    keep = {p.lower() for p in protect}
    this_year = time.localtime().tm_year
    for m in merged:
        s, e = m["start"], m["end"]
        # A span may start on the space before its word: skip it before stretching to whole words.
        while s < e and text[s].isspace():
            s += 1
        while s > 0 and WORD.match(text[s - 1]) and WORD.match(text[s]):
            s -= 1
        while e < len(text) and WORD.match(text[e]):
            e += 1
        # "Okonkwo's" is Okonkwo.
        if re.search(r"['’]s$", text[s:e]):
            e -= 2
        word = text[s:e].strip()
        if not word or m["score"] < MIN_SCORE.get(m["label"], DEFAULT_MIN):
            continue
        # A date is private when it's somebody's (a birthday), not when it's a deadline: keep one only
        # with a year at least ten years back.
        if m["label"] == "private_date":
            years = [int(y) for y in re.findall(r"\b(19\d\d|20\d\d)\b", word)]
            if not years or max(years) > this_year - 10:
                continue
        if word.lower() in keep or word.lower().rstrip("'’s") in keep:
            continue
        out.append({"label": m["label"], "start": s, "end": s + len(text[s:e].rstrip()), "text": word, "score": round(m["score"], 3)})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # never the request line or anything in it

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True, "model": "openai/privacy-filter", "revision": REVISION, "device": "cpu", "up_s": round(time.time() - started)})
        self.send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/scan":
            return self.send(404, {"error": "not_found"})
        try:
            n = int(self.headers.get("content-length", "0"))
            if n > MAX_CHARS * 4:
                return self.send(413, {"error": "too_large"})
            body = json.loads(self.rfile.read(n) or b"{}")
            text = str(body.get("text", ""))[:MAX_CHARS]
            protect = [str(p) for p in body.get("protect", [])][:200]
        except Exception:
            return self.send(400, {"error": "bad_json"})
        t = time.time()
        spans = spans_of(text, protect) if text.strip() else []
        log(f"scanned {len(text)} chars in {(time.time() - t) * 1000:.0f} ms: {len(spans)} span(s)")
        self.send(200, {"spans": spans})


log(f"loaded in {time.time() - started:.1f}s; listening on {HOST}:{PORT}")
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
