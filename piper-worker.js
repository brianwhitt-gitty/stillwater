// Stillwater fast-voice worker (Piper, voice "Norman").
// Runs a small Piper voice model entirely inside this browser tab.
// Every file it needs is served from this page's own folder; requests to any other site are refused here.
// This is a classic worker so Piper's official pronunciation helper (piper_phonemize.js) loads unchanged.

const ROOT = new URL("./", self.location.href);
const VOICE = "piper/voices/en_US-norman-medium.onnx";

// Large files are stored in pieces (with a .wasm ending, which every host serves as raw bytes) and joined here.
const CHUNKED = {
  "piper/voices/en_US-norman-medium.onnx": { parts: 4, type: "application/octet-stream" },
  "lib/ort-wasm-simd-threaded.jsep.wasm": { parts: 2, type: "application/wasm" },
};
const TOTAL_BYTES = 63531379 + 21596019 + 18077249;
let loadedBytes = 0;
function progress(n) {
  loadedBytes += n;
  self.postMessage({ type: "progress", loaded: Math.min(loadedBytes, TOTAL_BYTES), total: TOTAL_BYTES });
}

const realFetch = self.fetch.bind(self);
async function fromHere(path) {
  const spec = CHUNKED[path];
  if (!spec) return realFetch(new URL(path, ROOT));
  const pieces = [];
  for (let i = 0; i < spec.parts; i++) {
    const r = await realFetch(new URL(path + ".part" + i + ".wasm", ROOT));
    if (!r.ok) throw new Error("Missing voice file piece: " + path + ".part" + i + ".wasm");
    const buf = await r.arrayBuffer();
    pieces.push(buf);
    progress(buf.byteLength);
  }
  const blob = new Blob(pieces, { type: spec.type });
  return new Response(blob, { status: 200, headers: { "content-type": spec.type, "content-length": String(blob.size) } });
}

// Privacy guard: only this page's own files (and in-memory blob/data URLs) can be fetched.
self.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw, self.location.href);
  if (u.protocol === "blob:" || u.protocol === "data:") return realFetch(input, init);
  if (u.origin === self.location.origin) {
    for (const key of Object.keys(CHUNKED)) {
      if (u.pathname.endsWith("/" + key)) return fromHere(key);
    }
    return realFetch(input, init);
  }
  throw new TypeError("Stillwater blocked a request to " + u.origin);
};

let ort = null, session = null, config = null, phonemizer = null, loading = null;
const phonemeLines = [];

async function makePhonemizer() {
  // Piper's official pronunciation helper (espeak-ng), loaded unchanged from this site.
  importScripts(new URL("piper/lib/piper_phonemize.js", ROOT).href);
  const dataUrl = new URL("piper/lib/piper_phonemize.data.wasm", ROOT).href;
  const dataBuf = await (await realFetch(dataUrl)).arrayBuffer();
  progress(dataBuf.byteLength);
  return createPiperPhonemize({
    print: (line) => phonemeLines.push(line),
    printErr: () => {},
    noExitRuntime: true,
    locateFile: (f) => f.endsWith(".wasm") ? new URL("piper/lib/piper_phonemize.wasm", ROOT).href : f,
    getPreloadedPackage: () => dataBuf,
  });
}

function phonemeIds(text) {
  phonemeLines.length = 0;
  const voice = (config.espeak && config.espeak.voice) || "en-us";
  phonemizer.callMain(["-l", voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  const ids = [];
  for (const line of phonemeLines) {
    try { ids.push(...JSON.parse(line).phoneme_ids); } catch (e) { /* not a result line */ }
  }
  return ids;
}

async function load() {
  if (session) return;
  if (!loading) {
    loading = (async () => {
      ort = await import(new URL("piper/lib/ort.webgpu.min.mjs", ROOT).href);
      ort.env.wasm.wasmPaths = {
        mjs: new URL("lib/ort-wasm-simd-threaded.jsep.mjs", ROOT).href,
        wasm: new URL("lib/ort-wasm-simd-threaded.jsep.wasm", ROOT).href,
      };
      config = await (await realFetch(new URL(VOICE + ".json", ROOT))).json();
      phonemizer = await makePhonemizer();
      const model = await (await fromHere(VOICE)).arrayBuffer();
      session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
      self.postMessage({ type: "ready" });
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

async function speak(text, speed) {
  const ids = phonemeIds(text);
  if (!ids.length) return new Float32Array(0);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
  };
  const out = await session.run(feeds);
  return Float32Array.from(out.output.data);
}

const jobs = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (jobs.length) {
    const job = jobs.shift();
    const started = performance.now();
    try {
      await load();
      const rate = (config.audio && config.audio.sample_rate) || 22050;
      const audio = await speak(job.chunks.join(" "), job.speed);
      self.postMessage({ type: "audio", id: job.id, audio, rate, ms: performance.now() - started }, [audio.buffer]);
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
    const i = jobs.findIndex((j) => j.id === msg.id);
    if (i > 0) jobs.unshift(jobs.splice(i, 1)[0]);
  } else if (msg.type === "drop") {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (msg.keep.indexOf(jobs[i].id) === -1) {
        self.postMessage({ type: "error", id: jobs[i].id, message: "dropped" });
        jobs.splice(i, 1);
      }
    }
  }
};
