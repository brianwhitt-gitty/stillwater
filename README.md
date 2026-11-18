# Stillwater

Paste a meditation and hear it read slowly, with a quiet pause after every sentence.

**Private by design.** Stillwater is a static page: there is no server, account, database or analytics. Meditations stay in the open browser tab and disappear when it closes. Speech is generated on the listener's own device, either by the Kokoro AI voice model running in the page or by the device's built-in voices. The page loads only its own files and makes no requests to other sites.

## What's here

| Path | What it is |
| --- | --- |
| `index.html` | The page and player |
| `tts-worker.js` | Runs the Kokoro voice model in a background thread; refuses requests to any other site |
| `coi-serviceworker.js` | Adds two headers GitHub Pages can't set, so the voice engine can use several processor cores. Stores and sends nothing. |
| `kokoro/` | Kokoro-82M v1.0 (ONNX, q8) model in pieces under 20 MB, tokenizer and 8 voice files |
| `lib/` | kokoro-js 1.2.1 and the ONNX Runtime Web engine from Transformers.js 3.5.1 |

Binary files carry a `.wasm` ending so every host serves them as raw bytes; the worker joins the pieces back together.

## Verified copies

| File | SHA-256 | Matches |
| --- | --- | --- |
| `onnx/model_quantized.onnx` (joined) | `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478` | Hugging Face `onnx-community/Kokoro-82M-v1.0-ONNX` |
| `lib/kokoro.web.js` | `6067712fe4c43cdb36c762f860a5ab8d96ea1d9c8882466438eb9f3d0d20be8f` | jsDelivr `kokoro-js@1.2.1` |
| `ort-wasm-simd-threaded.jsep.wasm` (joined) | see jsDelivr `@huggingface/transformers@3.5.1` | jsDelivr published hash |

To check the model yourself: `cat kokoro/onnx/model_quantized.onnx.part*.wasm | shasum -a 256`

## Credits and licenses

- Kokoro-82M by hexgrad, Apache-2.0
- kokoro-js by Xenova, Apache-2.0 (`lib/LICENSE.txt`)
- ONNX Runtime Web (Microsoft), MIT, bundled via Transformers.js (Apache-2.0)
- eSpeak NG phonemizer, GPL-3.0, bundled inside kokoro-js
