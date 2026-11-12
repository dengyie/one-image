# Project State

## Objective

Maintain OneImage as a browser-first image workbench and keep its provenance path deployable through GitHub Actions to pxed.

## Current Phase

Provenance target fix deployed and online-verified.

## Current Branch

`main` is at `4d631b9`, deployed to pxed. Provenance inspects the current edited result, clears stale
evidence after new output, and labels C2PA/SynthID separately from visible watermark detection.

## Last Verified

2026-10-20 Asia/Shanghai: 84 tests, TypeScript, frontend/server builds pass. GitHub Actions
`39319023474` verify/package/deploy-pxed succeeded; pxed revision matches and oneimage/nginx are
RUNNING. Public health/capabilities returned 200. Public browser QA confirms crop resize/move,
32px hit targets, 400x300 PNG mosaic preview/export with unchanged outside pixels, 390px mobile fit,
and no browser exceptions.

2026-10-21 Asia/Shanghai: Actions `39472672171` verify/package/deploy-pxed all succeeded; pxed
revision matches and oneimage/nginx are RUNNING. Public health/capabilities returned 200. Public
browser regression sent `original.png` before export and an `edited` filename after export; the card
explicitly states C2PA/SynthID is not visible-watermark detection.
Earlier the same day: 84 tests, TypeScript, frontend/server builds pass. Browser QA confirms
desktop crop resize/move, native touch resize with 32px target, 390px mobile fit, mosaic blocks in
preview and full-resolution PNG export, outside-mask pixel preservation, and mosaic undo/redo/reset.

2026-10-19 Asia/Shanghai: 82 tests, TypeScript, frontend/server builds pass. Browser QA confirms
global/local slider targeting, local-on-global pixel composition, same-file reset, current-editor
input into compress tool (`200x120` retained), and 390px mobile without horizontal overflow.
Actions `39193251326` verify/package/deploy-pxed all succeeded. Public health/capabilities returned
200; 320x180 PNG rotation/local sharpening/WebP export produced 180x320; 390px mobile had no
horizontal overflow or browser exceptions.

2026-10-18 Asia/Shanghai: smoke-test found a preview aspect-ratio display bug; fix `5137eb7` deployed
through Actions run `39121790162` (verify/package/deploy-pxed all green). Passed 81 OneImage tests,
TypeScript, frontend build, and local browser check. Public smoke: pxed revision matches;
Supervisor/Nginx RUNNING; health/capabilities 200; valid PNG upload, 1:1 crop overlay measured at
ratio 1.0, local region/sharpen/rotate/mirror/export passed; 390px mobile has no horizontal overflow;
no browser exceptions.

Earlier 2026-10-15 Asia/Shanghai: Online smoke test of production `image.mangoqwq.com` (release `d3dad4c`).
Passed: `/healthz` 200; `/api/v1/capabilities` 200 (`provenance.enabled=true`, provider `openai`,
`maxInputBytes=26214400`); JSON error envelope for non-multipart, signature/MIME mismatch, and AVIF
input (all `400 invalid-input`); happy path JPEG/PNG/WebP return `200` with real C2PA and SynthID
evidence; the per-client limiter returns `429` after 30 requests in a window (verified on the origin
and through nginx). Failed: uploads above roughly 200 KB over Cloudflare are throttled to ~60-90 KB/s
and end in a Cloudflare `502` or a client timeout. The app itself is fast (12 MB in ~5 s on loopback)
and nginx locally is fast (5 MB in ~2 s), so the constraint is the Cloudflare->origin tunnel leg.

Earlier: Actions run `38632226498` verify/package/deploy all succeeded for the rate-limiter and tool-contract fixes (`3a31e16`, `70ea40e`). 56 local tests pass, gateway 25/25.

Earlier the same day: Actions run `38621428349` verify/package/deploy all succeeded for two post-review commits (`69d4572` dead-code removal, `22b19a8` shared input-format policy). tsc, frontend build, server build, and 46 local tests pass. Live `image.mangoqwq.com`: `/healthz` 200, PNG upload passes the MIME gate to the provider, AVIF upload returns `400 invalid-input`.

## Active Risks

- OpenAI key is intentionally retained as a dedicated test key per owner instruction; rotate before production use.
- AI image generation provider, pricing, quota, and policy selection remain P1 product work.
- Large uploads through the Cloudflare tunnel to pxed are throttled (~60-90 KB/s) and fail with `502`
  above a few hundred KB. App and nginx are both fast locally, so this is host/tunnel-side and outside
  the repo-only change scope.
- The repository Nginx template now uses `client_max_body_size 26m` and forwards the Cloudflare client
  address; pxed was already updated to the same body limit during the prior smoke-test repair.
- The OneImage app's stdout is not captured on pxed: `fd 1` is a pipe and `out.log` has been frozen
  since 2026-10-15 08:53 +0800, so request logs are unavailable (host-side observability gap; the pipe
  could eventually fill and block the process).
- The pxed release parent (`/personal/pxed/oneimage`) is on NFS with a quota that can fail at `close(2)`;
  the receiver keeps the Supervisor entrypoint (`$root/run.sh`) as an atomic symlink, cleans stale
  temporary symlinks, and excludes active `current`/entrypoint releases from retention cleanup.

## Active Blockers

None for the current P0 deployment milestone.

## Current Focus

Select and contract-test the first AI image generation provider with explicit cost and quota controls.

## Next Milestone

Select and contract-test the first AI image generation provider with explicit cost and quota controls.

## Key Artifacts

- Production: `https://image.mangoqwq.com`
- Server: `/personal/pxed/oneimage`, Supervisor program `oneimage`
- Gateway package: `providers/content-provenance-gateway/` at v3 baseline `f6b4a23`
- Canonical docs: `01.项目/OneImage/OneImage 文档索引.md`, `01.项目/OneImage/OneImage 开发文档.md`

## 2026-11-12 LaMa 服务端化部署 + 宿主终局判定

- 线上 main `8087b5bc`（PR #49 服务端 LaMa 智能修复 + PR #50 真实 warm 探针/诚实门）。生产 `.env`：`ONEIMAGE_LAMA_MODEL_PATH=/var/lib/oneimage/lama_int8qdq2.onnx`（59MB INT8 量化，sha256 校验过）。
- **宿主终局（实测）**：Linux ORT 上该模型 run 阶段激活峰值 ~499MB（FFC fp32 频域分支结构性），pxed 4GB 宿主极限 free 405MB（停 19 服务后）——端到端不可达。capabilities 反映真实 warm 态：warm 不落 → 档位自动隐藏 + route 503 `smart_erase_warming`。**ECI 升配 4→8GB 或迁宿主后零代码自动点亮**。
- `/proc/meminfo` 在 ECI 宿主被 lxcfs 虚拟化（Slab=0 假象），真实水位只看 `/proc/zoneinfo`。
- 影子实例已撤；19 个曾停服务已全部恢复（49 RUNNING）。详见 vault §16.50。
- **本机点亮验证（11-12）**：生产同款 bundle 本机 200/2.9s、洞外 bit-exact True、capabilities 动态翻转实测——P0 修复经真实 IPC 验证，「升配即点亮」为实测事实（详见 vault §16.50 追记）。
- **深度 review 加固（11-13，PR #51）**：线上 `f79667a6`。CBOR 扫描预算（匿名 DoS）、上游响应字节封顶、优雅关闭 disposeLamaPools、估算预览化、sharpen scratch、掩膜失败恢复、worker 看门狗、fastify/ORT 安全升级（ORT 1.31 原生跳跃经本地真实推理 bit-exact 背书）、CI audit 门、receiver 探针补 smartErase。Backlog 见 vault §16.51。
- **review 第二批（11-13，PR #52）**：线上 `8afc2a04`。token 时序比较、scrypt N=2^16（maxmem 必须显式，32MB 默认拒绝 2^16）+s2$ 自描述格式+登录重哈希、ECONNRESET 双扣费收窄、email-code/auth-password 直测（457 tests）、5 modal lazy + PointerRipples 门控（主 chunk 404.9KB）、CI 归档断言。
- **review 第三批（11-13，PR #53）**：线上 `4b3b2911`，466 tests。history 字节预算+原子合并、擦除管线抽取（App.tsx 1927 行）、downloadBlob/isProvenanceDetected 去重、onemail/cloud-quota 补测。Backlog 仅剩：App.tsx 后续 hook 抽取、BottomDock context 化（纯重构）；SSRF/XFF 有意不修（decisions.md）。
- **review 第四批（11-13，PR #54）**：线上 `88a2a6da`，466 tests。手势门控 undo/redo、toast 清理、saveLocalHistory 诚实 null、useDraftPersistence hook（App.tsx 1851 行）、CI per-ref 并发+deploy 串行组。**教训：workflow job 级 concurrency 缩进错位 = 幽灵 job 0s 解析失败且无注释，PyYAML 本地校验**。Backlog：useWorkingSet/BottomDock context（纯重构，记 backlog）。
- **review 第五批（11-13，PR #55）**：线上 `92bc5fb2`。预览直写主画布 + scratch 池 + wheel 原生监听——frontend review 表全部处理完毕。深度 review 五批全收口：466 tests、App.tsx 1851 行、无已知缺陷。
