# OneImage

OneImage is a local-first image workbench. P0 tools run in the browser and do not upload the source image. Remote AI and provenance providers are isolated behind server-side adapters so browser code never receives provider secrets.

## Current implementation

- Browser tools: format conversion, compression, resize, visible watermark, metadata-clean export; processing prefers a module Worker with an OffscreenCanvas path and keeps a browser fallback.
- Domain contracts: `ToolRegistry` and deterministic local job state machine.
- Provider boundary: `OpenAIProvenanceAdapter` maps C2PA and SynthID evidence independently.
- Server boundary: `POST /api/v1/provenance/openai` accepts one bounded multipart image, streams it through a private temporary file, and keeps `OPENAI_API_KEY` server-side.
- Operations boundary: `GET /healthz` returns `200` when the provider is configured and `503` degraded status otherwise, without exposing secrets. It checks configuration, not upstream connectivity.
- AI image generation (text-to-image and image-to-image): server-side provider adapters (`openai-images` for OpenAI `gpt-image-*` / xAI `grok-2-image*` / OpenAI-compatible aggregators, `openai-chat-image` for aggregator models exposed only on the chat surface that answer with the file in the message — e.g. xAI `grok-imagine-*` behind new-api, `gemini` for direct Google `generateContent`). Providers are configured only on the server via `ONEIMAGE_IMAGE_PROVIDERS_FILE` (or inline `ONEIMAGE_IMAGE_PROVIDERS` JSON) with `baseUrl`, `apiKey` and the model list; the browser sees provider names and models through `GET /api/v1/imagegen/capabilities` and never a key or URL. `POST /api/v1/imagegen` is rate-limited per client and bounded by a durable daily cap counted in *images* (`ONEIMAGE_IMAGEGEN_DAILY_CAP`, default 20/day per client — a 4-image request spends 4). A request for `n` images fans out in parallel (at most 3 in flight) and returns whatever succeeded with a `failed` count, so one upstream error does not throw away images already billed. Sizes are reported honestly: every result carries the real `width`/`height` parsed from the returned container, plus the `requestedSize` echoed back, because some models ignore the size they are asked for. A self-hosted backend reached through an aggregator usually answers with a URL built from *its own* loopback address; set `mediaOrigin` to where that backend is actually reachable and the adapter re-points the path and query there, downloading it directly (never through an outbound proxy). Image-to-image is opt-in per provider through `editModels` (a subset of `models`; absent means the picker shows no reference-image affordance at all). A reference travels as `{ mimeType, base64 }` and is validated before any spend — PNG/JPEG/WebP only, ≤ 6 MiB decoded, magic bytes agreeing with the declared type, 16–8192 px — then forwarded in whichever dialect the provider speaks: multipart to `/images/edits`, a multimodal `image_url` data URL on the chat surface, or an `inlineData` part for Gemini. The `openai-images` edit dialect is itself configurable via `editsStyle` (`multipart` by default; `xai-json` — the xAI body that carries the reference as an embedded data URL, needed because a new-api gateway fronts the xAI upstream and answers the multipart form with "no channel for this model"). The browser downsizes the reference to 2048 px / 5 MiB and defaults to sending the current canvas (crop, rotation, colour and annotations already baked in) rather than the original upload. Results land in the workbench for further editing.
- Per-model capabilities and video (2026-11 refactor): a provider's `models` now accepts objects alongside plain strings — `{ id, dialect?, sizes?, fixedSizeNote?, edit?, editsStyle?, generationConfig?, note?, timeoutMs? }` — so one gateway (e.g. api.mangoqwq.com) is one provider whose models differ in endpoint surface (`openai-images` / `openai-chat-image` / `gemini`, inherited from the provider `type` unless overridden), aspect control, reference-image support and latency hint. The provider-level fields keep their meaning as fallbacks for string entries, and `editModels` is derived (`edit: true` flags ∪ explicit entries), so existing configs behave exactly as before. Deliberately-offline models (no upstream channel, unusable latency) go in `disabledModels: [{ id, reason }]` — documented in the file, exposed nowhere in the capabilities, so the picker never shows a button that can only 500. `GET /api/v1/imagegen/capabilities` projects `modelInfos` per provider (sizes/fixedSizeNote/edit/note/timeoutMs resolved) and a `video.providers` section when any model declares the per-model dialect `openai-chat-video`. Video generation has its own surface: `POST /api/v1/videogen` (one prompt → one clip, synchronous chat round-trip, raw bytes back with `X-Video-Model`/`X-Video-Mime`/`X-Video-Bytes` headers; no size, no count, no reference image), `GET /api/v1/videogen/quota`, and a separate durable daily cap (`ONEIMAGE_VIDEOGEN_DAILY_CAP`, default 5/day per client) plus its own burst limiter (3/min). Video containers are mime-sniffed from the bytes (`ftyp` → mp4, EBML → webm) and capped at 64 MiB; results play in a dedicated modal and never enter the bitmap workspace. Both surfaces expose their remaining budget (`GET /api/v1/imagegen/quota`, `GET /api/v1/videogen/quota`) so the UI can show 今日剩余 N 张/段 instead of teaching the cap through a 429. A ready-to-edit lineup for the api.mangoqwq.com gateway lives in `deploy/imagegen.json.template`.

- Smart erase (智能修复): browser-local watermark inpainting. The fourth erase type draws marquee regions; running the repair executes the MI-GAN pipeline (`migan_pipeline_v2.onnx`, 26.8 MB, MIT) fully on-device via onnxruntime-web (WebGPU first, WASM fallback) in a dedicated worker, and composites only the masked pixels back — pixels outside the mask are preserved bit-for-bit and the image is never uploaded. The model is self-hosted at `/models/` (stable content, download once per host with `npm run fetch-model` for dev or copy to `/personal/pxed/oneimage/models/` in production; the ORT runtime assets under `/models/ort/` come from the release build). Verified model contract: mask 0 = inpaint hole, 255 = keep (`scripts/verify-model-contract.mjs`).
- Accounts and cloud sync: email-code sign-up and sign-in (`POST /api/v1/auth/email-code`, `/register`, `/login`, `/logout`, `GET /me`, `PATCH /profile`). Codes are stored only as hashes with a 10-minute TTL, 5 attempts, a 60-second resend cooldown and 5 sends per hour per address; the session lives in an HttpOnly cookie and the token is never handed back to browser code. Signed-in projects (`/api/v1/projects`) keep editor state and a thumbnail per account with a 50-project / 64 MiB ceiling; the list endpoint projects metadata only and the heavy fields come from `GET /api/v1/projects/:id`. Local history without an account stays in browser storage.
- UI: responsive workbench with local preview, drag-and-drop input, cancellation, export, and privacy status.

OCR, segmentation, upscaling, and remote inpainting remain gated behind the validation probes in the project development document. They are not represented as silently working features.

Invisible traces are handled without repainting pixels: the metadata-clean export removes container-level EXIF/GPS/XMP/C2PA segments in place (JPEG, PNG, WebP) and refuses formats it cannot edit safely instead of re-encoding them. Pixel-domain watermarks such as SynthID cannot be removed without changing the image, so the app detects and reports them rather than claiming removal.

## Run

```powershell
npm install
npm test
npm run build
npm run server
npm run dev
```

The production build is static. Run the Fastify adapter separately with `npm run server`; it bundles a CommonJS Node entrypoint before starting, defaults to `127.0.0.1:8787` locally, and reads `OPENAI_API_KEY` server-side. The pxed deployment sets `PORT=8877` in its private `.env`. Vite proxies `/api` to that local server during development. Configure `NODE_ENV=development` explicitly to allow the no-token same-origin development proxy. Production and unset environments require `ONEIMAGE_SERVER_TOKEN` or an equivalent authenticated reverse-proxy session. Do not import the adapter into browser UI code or expose that key to the client.

For constrained environments, set `ONEIMAGE_SERVER_BUILD_DIR` to a writable directory before `npm run server:build`; otherwise the build uses the system temporary directory and produces `index.cjs`.

The production Nginx example under `deploy/` listens on loopback port `3302`, proxies `/api/` to Fastify on `8877`, and serves the static build for `image.mangoqwq.com`. Its token include is host-only at `/personal/pxed/nginx/oneimage-secret.conf` (outside the globally included `conf.d` directory), mode `0600`, and never part of a release archive. GitHub Actions expects `PXED_DEPLOY_KEY`, `PXED_KNOWN_HOSTS`, and `PXED_DEPLOY_HOST` in the `production` environment; the deploy key must be restricted to the fixed receiver command. Keep the Cloudflare Tunnel catch-all ingress last when adding this hostname.

## Provenance gateway package

`providers/content-provenance-gateway/` is a self-contained package in this
monorepo: a small, separately deployable Node service that exposes OpenAI's
`POST /v1/content_provenance_checks` as an **anonymous** endpoint (the upstream
key stays server-side, with per-IP rate limiting, a daily cost cap, a concurrency
limit, and a body-size cap).

It is included as a self-contained reference for the provenance data source and is
deployed independently; OneImage does not depend on it at runtime. A normal clone
contains the package:

```bash
git clone https://github.com/dengyie/oneimage.git
```

## Layout

```text
src/domain/          pure contracts and state transitions
src/application/     file policy and use-case orchestration
src/infrastructure/  browser image processing and provider adapters
src/App.tsx          presentation layer
tests/               Vitest behavior tests
providers/           independently deployable provider packages
```
