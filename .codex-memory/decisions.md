# Decisions

## 2026-10-21 - Check provenance against the current result and separate it from visible watermark detection

- Decision: When an edited/tool result exists, the provenance action sends that Blob as a File; new output clears the previous evidence card. UI copy identifies the result as C2PA/SynthID content provenance, not visible-watermark detection.
- Rationale: The prior App path always passed the original `file`, and retained evidence after export. This made a successful edit appear to still contain the original signal and conflated two different detection domains.
- Impact: The first check after upload targets the original; the next check after export targets the edited result and cannot display stale evidence from the previous target.
- Rollback trigger: If separate per-artifact history is required, retain an evidence record keyed by artifact URL instead of one shared card.
- Related files: `src/App.tsx`, `src/infrastructure/provenance-client.ts`, `tests/provenance-client.test.ts`.

## 2026-10-20 - Keep crop no-op by default and make local mosaic a bounded region operation

- Decision: Preserve full-image crop on load; expose an explicit action that creates a centered 82% crop selection; use 32px pointer hit areas with compact visible markers. Model pixelation as optional `mosaicBlockSize` on a local adjustment and render it through a downscaled region canvas followed by nearest-neighbor compositing.
- Rationale: A full-image crop cannot translate because movement is clamped to source bounds; small handles were difficult to grab. A region-sized scratch canvas limits temporary pixel work while applying identical geometry to preview and full-resolution export.
- Alternatives considered: Changing the initial crop to 82% would make uploads silently crop by default; processing an entire full-resolution frame for mosaic would allocate unnecessary memory; server processing would break local-first privacy.
- Impact: Crop is opt-in, mosaic stays local and participates in history, and the same transformed rectangular mask is used for local adjustments and pixelation.
- Rollback trigger: If a target browser lacks Canvas 2D/offscreen support, preserve the local state contract and route the scratch surface through the existing HTML canvas factory fallback.
- Related files: `src/domain/editor-state.ts`, `src/components/ImageEditor.tsx`, `src/application/editor-renderer.ts`, `tests/editor-renderer.test.ts`, `tests/image-editor-model.test.ts`.

## 2026-10-19 - Keep tool processing downstream of the current editor snapshot

- Decision: The editor's “run current tool” action exports its current state as the tool input; App passes only options consumed by the selected tool. Local adjustments composite onto the global render, and adjustment controls target global or an explicitly selected region.
- Rationale: The prior action processed the original File and overwrote the editor result; local regions redrew original pixels and erased global adjustments; selection changed the slider target implicitly.
- Alternatives considered: Removing the legacy tools was rejected because the registry remains part of the workbench; a hidden implicit “selected region” mode was rejected because it cannot return to global controls predictably.
- Impact: Existing local tools remain available in the editor flow, with the current rendered state and a fresh source selection as their input.
- Rollback trigger: If downstream tools are replaced by editor-native operations, remove the bridge and migrate their options into EditorState.
- Related files: `src/App.tsx`, `src/components/ImageEditor.tsx`, `src/application/editor-renderer.ts`, `tests/editor-renderer.test.ts`.

## 2026-10-18 - Use a parameterized local editor state with bounded preview rendering

- Decision: Keep the original image immutable, store crop/transform/adjustment/local-region parameters in `EditorState`, render a max-1600px preview with `requestAnimationFrame`, and re-render the same state at source resolution for export.
- Rationale: This supports continuous pointer/touch editing, reliable undo/redo, and local privacy without repeatedly decoding or permanently mutating pixels.
- Alternatives considered: Re-encode after every operation was rejected because it accumulates quality loss and makes history expensive; a server editor was rejected because the product is local-first.
- Impact: New editor logic is split into domain state, application renderer, infrastructure decoder, and React interaction component; no runtime dependency was added.
- Rollback trigger: Browser memory limits or unsupported Canvas filter behavior require reducing preview size or disabling a filter while preserving the state contract.
- Related files: `src/domain/editor-state.ts`, `src/application/editor-renderer.ts`, `src/infrastructure/editor-canvas.ts`, `src/components/ImageEditor.tsx`, `docs/superpowers/specs/2026-10-17-realtime-image-editor-design.md`.

## 2026-10-16 - Bind provider work to request lifetime and make deployment cleanup crash-safe

- Decision: drain rejected multipart files, propagate request aborts to the provider fetch, trust the same forwarded client key in the Nginx template, and exclude active release symlinks from receiver retention cleanup.
- Rationale: unconsumed multipart streams can hold request resources; disconnected clients should not keep billable provider calls alive; a template mismatch collapses rate limiting behind Nginx; and crash leftovers or active-release deletion can break the next deploy or rollback.
- Impact: the route now has explicit request cancellation semantics, and the deploy path is recoverable after interrupted symlink swaps.
- Related files: `server/provenance-route.ts`, `src/infrastructure/openai-provenance-adapter.ts`, `deploy/nginx-image.example.conf`, `deploy/oneimage-deploy-receiver.sh`.

## 2026-10-17 - Treat response close as client cancellation after upload completion

- Decision: Keep the request `aborted` listener for incomplete uploads and also listen to the response `close` event; abort provider work only when `reply.raw.writableEnded` is false.
- Rationale: Once the request body is fully consumed, `IncomingMessage.aborted` no longer reports that a client stopped waiting. A response close before normal completion is the lifecycle signal that reaches the provider AbortSignal.
- Impact: Completed uploads no longer leave billable upstream calls running after the browser disconnects; normal response completion does not self-cancel.
- Related files: `server/provenance-route.ts`, `tests/provenance-route.test.ts`.

## 2026-10-14 - Keep the provenance gateway in the monorepo and the default runtime same-origin

- Decision: Keep `providers/content-provenance-gateway/` as a normal package in the OneImage monorepo, while keeping OneImage's default provider on its own Fastify route.
- Rationale: The user requested one source repository. The gateway still has an independent process, package lock, tests, and deployment boundary; using the maintainer's anonymous public endpoint by default would silently upload images to a third-party host for downstream deployers.
- Impact: A normal clone contains the gateway; CI tests it directly without submodule initialization. Runtime configuration remains local-first.
- Rollback trigger: A future explicit operator-controlled endpoint must include a visible recipient/retention policy and an opt-in configuration.
- Related files: `providers/content-provenance-gateway`, `server/provenance-route.ts`, `01.项目/OneImage/OneImage 开发文档.md`.

## 2026-10-14 - Use restricted stdin streams for pxed release uploads

- Decision: The forced deployment key accepts only `upload <40-hex-sha> archive|checksum` commands; the receiver writes the stream to the matching `/tmp/oneimage-<sha>` path and then performs checksum, archive, install, restart, and health checks.
- Rationale: OpenSSH scp/SFTP negotiation is incompatible with a forced-command-only key. The stdin protocol preserves least privilege and avoids shell, arbitrary path, and SFTP access.
- Impact: GitHub Actions can deploy automatically without exposing a general-purpose SSH key.
- Rollback trigger: Any receiver validation bypass or failed atomic rollback requires disabling the deployment key and restoring the previous release symlink.
- Related files: `.github/workflows/ci.yml`, `deploy/oneimage-deploy-receiver.sh`.

## 2026-10-15 - Make the accepted input formats and size ceiling a single source of truth

- Decision: Define `SUPPORTED_IMAGE_MIME` (JPEG, PNG, WebP) and `MAX_INPUT_BYTES` (25 MB) once in `src/domain/image-input.ts`, and read them from browser validation, the tool registry, the server multipart limits, the provenance route, and the provider adapter. AVIF is removed from the accepted *input* set but remains a valid canvas *export* target for the convert tool.
- Rationale: The client dropzone advertised AVIF while the server route and the OpenAI provenance endpoint only accept JPEG/PNG/WebP, so a user could select a file the API immediately rejected. The 25 MB ceiling was also restated in four places and could drift from the multipart limit.
- Impact: Format changes are now a one-line edit; a table-driven route test pins every advertised MIME to a 200 and asserts AVIF is rejected with `400 invalid-input`.
- Rollback trigger: If the provenance provider starts accepting AVIF, add it back to the shared list in one place and extend the table-driven test.
- Related files: `src/domain/image-input.ts`, `src/application/file-policy.ts`, `src/domain/tool-registry.ts`, `server/provenance-route.ts`, `server/index.ts`, `src/infrastructure/openai-provenance-adapter.ts`, `src/App.tsx`.

## 2026-10-15 - Trust forwarded client addresses only from a loopback peer

- Decision: `server/client-ip.ts` reads `cf-connecting-ip` then the first `X-Forwarded-For` hop as the rate-limit key, but only when the immediate socket peer is loopback; otherwise the peer's own socket address is used.
- Rationale: Keying on `request.ip` alone collapsed every caller behind Nginx to `127.0.0.1`, sharing one 30/minute budget. Trusting forwarded headers unconditionally would let any client mint its own bucket. Loopback binding is the precondition that makes the header trustworthy, matching the bundled gateway's documented model.
- Impact: A live check on the built server showed one forwarded client denied at request 31 (429) while 32 distinct forwarded clients all passed.
- Rollback trigger: If the server is ever bound to a non-loopback interface, the forwarded-header trust assumption is void and `client-ip.ts` must change before that deploy.
- Related files: `server/client-ip.ts`, `server/rate-limit.ts`, `server/index.ts`, `tests/client-ip.test.ts`, `tests/rate-limit.test.ts`.

## 2026-10-15 - Delete maxPixels rather than implement it; read warningCodes from the registry

- Decision: Remove `maxPixels` from `ToolDefinition` and its three declarations. Make `warningCodes` authoritative by adding `resolveToolWarnings`; the worker returns only the artifact and the caller attaches warnings.
- Rationale: `maxPixels` was declared 40 MP on resize/crop/rotate with no reader, and a declared limit that nothing enforces is a guarantee the app does not make. `warningCodes` was duplicated as a hardcoded `toolId === 'compress'` ternary in two files.
- Impact: Adding a warning is a registry edit. Keeping the registry out of the worker bundle avoided growing it from 2.33 kB to 4.22 kB.
- Rollback trigger: If a CPU-plane path is added that must reject large images up front, reintroduce a pixel cap together with the enforcement, not as a declaration alone.
- Related files: `src/domain/tool.ts`, `src/domain/tool-registry.ts`, `src/infrastructure/browser-image-processor.ts`, `src/infrastructure/image-worker.ts`, `tests/tool-registry.test.ts`.


## 2026-11-12 LaMa 宿主不可行判定 + 诚实可用性门（PR #49/#50）

- **判定**：LaMa ONNX（任意量化变体）在 pxed 4GB 宿主不可常驻服务——Linux ORT run 阶段激活峰值 ~499MB（FFC 全分辨率 fp32 频域分支）> 宿主极限 free 405MB（zoneinfo 实测，meminfo 是 lxcfs 虚构）。量化只救 create（fp32 230MB → qdq2 ~150MB）不救 run。
- **决策**：部署诚实门——capabilities `smartErase.lamaAvailable` 反映真实 warm 态（create + 真实洞 tile run 全过才 true；探针零 mask 会跳过 session.run 的坑已修），未 warm 时 route 503 `smart_erase_warming`（在限流/计费之前）。宿主不足时档位对用户隐藏而非 500。**激活路径**：宿主升配后 warm 自然落位，零代码。
- **质量定案**：INT8 QDQ 四变体洞内 PSNR 16-18dB（fp32 对照）但填充视觉干净——生成式填充的 PSNR 门失效；选 qdq2（59MB，突发最小）。最终质量裁定权在 owner 公网人眼验收（需先升配）。

## 2026-11-13 全项目深度 review 定案（PR #51）

- **安全基线**：provenance CBOR 扫描（匿名可达）必须预算化——任何对 caller-controlled 字节流的逐 offset 启发式扫描都要有候选数/字节双预算；上游 HTTP body 读取必须流式封顶（AbortSignal 只限时不限字节）。
- **ORT 升版协议**：onnxruntime-node 跳大版本前必须过本地真实推理 e2e（session create + probe run + 洞外逐位 bit-exact）；本地裸跑 bundle 需 junction node_modules（release 形态天然满足）。
- **receiver 同步协议**：Windows 工作树 scp 直传会带 CRLF 使宿主 bash 语法崩溃——必须先转 LF（已发生一次并即时修复）；repo 副本为权威。
- **review 建议需验证**：两处 agent 建议被驳回（sharpen"原位卷积"改变滤波语义；掩膜"成功后清除"会清错文档）——修复前先读语义，报告不是真理。

## 2026-11-13 SSRF/XFF 有意不修（review 第三批定案）

- **SSRF DNS 解析校验不修**：imagegen 媒体面对 mesh/回环地址的私有出口是 mediaOrigin 特性（回环媒体走 directDispatcher），DNS 级私网封锁会砍掉该特性；真正的边界（https 强制 + mediaOrigin 同源 + key 不出 baseUrl 域）已存在。若未来 mediaOrigin 特性下线再重议。
- **XFF 首跳信任不修**：生产拓扑 nginx 仅绑 127.0.0.1 且覆写 XFF，cf-connecting-ip 优先已生效；改派生键会重置既有用户的限流/日额键，纯拓扑假设换来的回归风险不值。

## 2026-11-13 useWorkingSet/BottomDock context 化有意不做

- 纯代码搬运（无行为变化、无可新增断言），在已生产验证的 1900 行组件上搬 50+ 接线点的回归风险 > 可维护性收益。显式记 backlog 而非赶工。同理裁定收口：深度 review 全部 actionable 项至此处理完毕（P0/P1/P2 已修，P3 已修或论证）。
