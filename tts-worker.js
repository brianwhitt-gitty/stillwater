// Stillwater studio-voice worker.
// Runs the Kokoro voice model entirely inside this browser tab.
// Every file it needs is served from this page's own folder; requests to any other site are refused here.

const ROOT = new URL("./", self.location.href);
const HF = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Large files are stored in pieces under 20 MB (with a .wasm ending) and joined again here.
const CHUNKED = {
  "kokoro/onnx/model_quantized.onnx": { parts: 5, type: "application/octet-stream" },
  "lib/ort-wasm-simd-threaded.jsep.wasm": { parts: 2, type: "application/wasm" },
};
const TOTAL_BYTES = 92361116 + 21596019;
let loadedBytes = 0;

const realFetch = self.fetch.bind(self);

async function fromHere(path) {
  const spec = CHUNKED[path];
  if (!spec) {
    // Binary files are stored with a .wasm ending, which is what the page host accepts.
    const stored = path.endsWith(".bin") ? path + ".wasm" : path;
    const r = await realFetch(new URL(stored, ROOT));
    if (!r.ok) return new Response(null, { status: 404, statusText: "Not Found" });
    return r;
  }
  const pieces = [];
  for (let i = 0; i < spec.parts; i++) {
    const r = await realFetch(new URL(path + ".part" + i + ".wasm", ROOT));
    if (!r.ok) throw new Error("Missing voice file piece: " + path + ".part" + i + ".wasm");
    const buf = await r.arrayBuffer();
    pieces.push(buf);
    loadedBytes += buf.byteLength;
    self.postMessage({ type: "progress", loaded: loadedBytes, total: TOTAL_BYTES });
  }
  const blob = new Blob(pieces, { type: spec.type });
  return new Response(blob, {
    status: 200,
    headers: { "content-type": spec.type, "content-length": String(blob.size) },
  });
}

// Privacy guard: only this page's own files (and in-memory blob/data URLs) can be fetched.
self.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw, self.location.href);
  if (u.href.startsWith(HF)) {
    return fromHere("kokoro/" + u.href.slice(HF.length).split("?")[0]);
  }
  if (u.protocol === "blob:" || u.protocol === "data:") return realFetch(input, init);
  if (u.origin === self.location.origin) {
    for (const key of Object.keys(CHUNKED)) {
      if (u.pathname.endsWith("/" + key)) return fromHere(key);
    }
    return realFetch(input, init);
  }
  throw new TypeError("Stillwater blocked a request to " + u.origin);
};

let tts = null;
let loading = null;
const jobs = [];          // waiting sentences, in order
let busy = false;

async function load() {
  if (tts) return tts;
  if (!loading) {
    loading = (async () => {
      const { KokoroTTS, env } = await import("./lib/kokoro.web.js");
      env.wasmPaths = {
        mjs: new URL("lib/ort-wasm-simd-threaded.jsep.mjs", ROOT).href,
        wasm: new URL("lib/ort-wasm-simd-threaded.jsep.wasm", ROOT).href,
      };
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm" });
      self.postMessage({ type: "ready" });
      return tts;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

async function pump() {
  if (busy) return;
  busy = true;
  while (jobs.length) {
    const job = jobs.shift();
    const started = performance.now();
    try {
      const model = await load();
      const out = [];
      let length = 0, rate = 24000;
      for (const piece of job.chunks) {
        const audio = await model.generate(piece, { voice: job.voice, speed: job.speed });
        rate = audio.sampling_rate || rate;
        out.push(audio.audio);
        length += audio.audio.length;
      }
      const gap = out.length > 1 ? Math.round(rate * 0.18) : 0;
      const joined = new Float32Array(length + gap * (out.length - 1));
      let at = 0;
      out.forEach((a, i) => { joined.set(a, at); at += a.length + (i < out.length - 1 ? gap : 0); });
      self.postMessage({ type: "audio", id: job.id, audio: joined, rate, ms: performance.now() - started }, [joined.buffer]);
    } catch (err) {
      self.postMessage({ type: "error", id: job.id, message: String(err && err.message || err) });
    }
  }
  busy = false;
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "load") {
    load().catch((err) => self.postMessage({ type: "error", id: null, message: String(err && err.message || err) }));
  } else if (msg.type === "gen") {
    jobs.push(msg);
    pump();
  } else if (msg.type === "front") {
    // Move a sentence the listener is waiting for to the head of the line.
    const i = jobs.findIndex((j) => j.id === msg.id);
    if (i > 0) jobs.unshift(jobs.splice(i, 1)[0]);
  } else if (msg.type === "drop") {
    // Forget queued sentences that are no longer needed (new text, voice or pace).
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (msg.keep.indexOf(jobs[i].id) === -1) {
        self.postMessage({ type: "error", id: jobs[i].id, message: "dropped" });
        jobs.splice(i, 1);
      }
    }
  }
};
