# TODO

## In Progress

- None for the provenance target repair milestone.

## Next

- [x] Provider policy documented (2026-11-13, vault §16.64): grok/gemini/gpt-image-1 retention + training (paid APIs do not train; 30-55d abuse retention); quota/timeout/error already in config+routes. Provider selection itself was done earlier (grok default, §16.32/16.45).
- [ ] Add a provider contract test using a sandbox or deterministic fixture before enabling production traffic.

## Manual-required

(host/infra side, outside the repo-only change scope)

- [x] Raise nginx `client_max_body_size` to `26m` and sync the repository template.
- [x] Tunnel throughput re-measured 2026-11-13: ~2MB/s sustained, 5MB uploads fine (no 502; nginx 26m fixed the tail). The old 60-90KB/s reading was latency-dominated on small payloads.
- [x] App log capture: out.log active again (verified 2026-11-13, 830KB live request log).
- [x] Sync the receiver's atomic entrypoint symlink logic and protect active releases during cleanup.
- [ ] Rotate the dedicated OpenAI test key before any formal production release.

## Done

- [x] Deploy `4d631b9` through Actions `39472672171`; verify pxed revision/services, public health/capabilities, and edited-result provenance request targeting.
- [x] Make provenance checks use the current edited/tool result instead of always rechecking the original file; clear stale evidence after new output and clarify C2PA/SynthID semantics.

- [x] Deploy `7cfdfa3` through Actions `39319023474`; verify pxed revision, Supervisor/Nginx, public health/capabilities, crop resize/move, mosaic preview/export, outside-mask preservation, and mobile fit.
- [x] Restore usable crop resize/move interaction with an explicit centered crop entry, 32px hit targets, stable surface pointer capture, and a visible interaction hint.
- [x] Add browser-local adjustable mosaic regions with transformed rectangular masks, nearest-neighbor preview/export rendering, and undo/redo/reset coverage.
- [x] Verify desktop crop resize/move, Chromium touch resize, preview/export mosaic pixels, unchanged outside pixels, and 390px viewport fit locally.

- [x] Deploy `0ee554f` through Actions `39193251326`; verify pxed revision, Supervisor/Nginx, public health/capabilities, online rotation/local sharpening/WebP export, and 390px mobile fit.
- [x] Feed the current editor export to the selected legacy tool and pass only options relevant to that tool.
- [x] Apply local adjustments over the globally processed preview/export and expose explicit global/region targeting.
- [x] Reset editor history when the same file is selected again; clear the file input after selection.
- [x] Add local adjustment layering regression test; validate full flows with desktop/mobile Playwright.

- [x] Add browser-local non-destructive editor state, preview renderer, crop gestures, fixed ratios, arbitrary rotation, mirror, global/local adjustments, history, and full-resolution export.
- [x] Verify desktop and mobile browser workflows with temporary Playwright, including no horizontal overflow and local export.
- [x] Commit and deploy the realtime browser editor (`71a6662`, Actions `39071231196`) and verify pxed/public release state.
- [x] Fix the preview aspect-ratio distortion found during public smoke (`5137eb7`, Actions `39121790162`); re-run desktop/mobile export smoke online.
- [x] Close the post-upload client-disconnect cancellation gap (`ad1b3bb`); a real HTTP regression test failed before the response-close listener and passes after it.
- [x] Deploy `ad1b3bb` with GitHub Actions run `38986421928`; verify pxed revision and RUNNING services.
- [x] Re-run the public production checks: health/capabilities 200, valid PNG provenance 200 with C2PA/SynthID evidence, malformed signature 400; confirm no upload temp directories remain.
- [x] Sync `deploy/oneimage-deploy-receiver.sh` to the hand-patched host receiver (atomic `run.sh`
      symlink + rollback restore), closing the drift behind the `d3dad4c` `Disk quota exceeded` deploy failure.
- [x] Run an online smoke test of the production gateway (health, capabilities, validation, happy
      path, per-client rate limit) and attribute the large-upload `502`s to the tunnel leg, not the app.
- [x] Rate-limit per real client IP, trusting forwarded headers only from a loopback peer (`3a31e16`), with a live 429 check.
- [x] Make `warningCodes` authoritative via `resolveToolWarnings` and delete the unenforced `maxPixels` (`70ea40e`).

- [x] Perform a 9-dimension production code review and land the resulting cleanups: dead shims/unused exports removed (`69d4572`), shared MIME/size policy (`22b19a8`); CI run `38621428349` green and live-verified.
- [x] Drop the redundant `tests/browser-image-processor.test.ts` after migrating its unique assertions into `tests/image-ops.test.ts`.

- [x] Route OpenAI provenance through `undici.ProxyAgent` and pxed `HTTPS_PROXY`.
- [x] Repair GitHub Actions production secrets/variables and forced-command deployment receiver.
- [x] Replace SFTP/scp deployment upload with restricted SHA-scoped stdin streams.
- [x] Deploy `d7ca720` to pxed and verify health, capabilities, and public provenance PNG response.
- [x] Repin content-provenance submodule to v3 `f6b4a23`.
- [x] Convert content-provenance from submodule to a normal package in the OneImage monorepo.
- [x] Upgrade CI actions to Node 24 runtime.
- [x] Drain rejected multipart streams and propagate client disconnect cancellation to the OpenAI request.
- [x] Align the Nginx template with the trusted forwarded-client-IP rate-limit model.

## 2026-11-12 LaMa 服务端化收尾

- [x] PR #49 服务端 LaMa 档（审查 P0 result 处理器/prewarm 挂死/png 炸弹加固/pool 测试）部署。
- [x] PR #50 真实 warm 探针（零 mask 跳过 session.run 的坑）+ capabilities 真实 warm 态 + 503 warming 门，部署。
- [x] pxed 宿主终局实测：run 激活峰值 ~499MB > 宿主极限 405MB → 档位自动隐藏（诚实门生效，公网验收过）。
- [ ] **Manual-required**：LaMa 点亮需宿主升配（ECI 4→8GB）或迁宿主——owner 裁定；零代码，warm 落位即亮。
- [ ] **Manual-required**：点亮后 owner 公网人眼验收填充质量（INT8 填充 vs MI-GAN 的质量裁定，§16.50）。
- [ ] 可选迭代：MI-GAN 服务端化（26MB 模型 pxed 稳活，可靠但质量退回 owner 原裁定前水平）。
