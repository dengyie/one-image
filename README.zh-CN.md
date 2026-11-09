<div align="center">

# OneImage

**高性能本地优先浏览器图像处理工作台与 C2PA / SynthID 内容凭证溯源引擎**

[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19.3-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6.svg?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8.3-646CFF.svg?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4.svg?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Fastify](https://img.shields.io/badge/Fastify-5.12-000000.svg?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![ONNX Runtime](https://img.shields.io/badge/ONNX-WebGPU%20%7C%20WASM-005CED.svg?style=flat-square&logo=onnx&logoColor=white)](https://onnxruntime.ai/)
[![Tests](https://img.shields.io/badge/vitest-passing-brightgreen.svg?style=flat-square)]()

[English](./README.md) · [简体中文](./README.zh-CN.md) · [架构设计](#架构布局) · [部署运行](#本地运行)

</div>

---

## 项目概述

**OneImage** 是一款注重隐私、在浏览器本地运行的专业图像处理工作台，同时集成了 C2PA 与 SynthID 内容溯源核验引擎。

核心图像操作（格式转换、高压缩比压缩、尺寸重设、可见水印添加、EXIF/元数据无损擦除）100% 依托浏览器的 OffscreenCanvas 与 Web Workers 在客户端内部完成 —— 零图像数据上传到外部服务器。远端 AI 扩图与数字溯源接口则严格隔离在后端代理适配器内，防止上游 API 凭据泄露至前端。

---

## 核心实现特性

- **纯前端工具集**：格式转换、压缩、缩放、可见水印、元数据清除导出；优先启用基于 OffscreenCanvas 的 module Worker 路径，并提供完整的主线程降级兜底。
- **领域数据契约**：内置 `ToolRegistry` 与确定性本地任务状态机。
- **模型凭据边界**：`OpenAIProvenanceAdapter` 独立映射 C2PA 与 SynthID 溯源证据。
- **服务端隔离**：`POST /api/v1/provenance/openai` 接收单张受限图片，经由受保护临时文件流式转发，`OPENAI_API_KEY` 严密保存在服务端。
- **运维探针契约**：`GET /healthz` 仅校验服务端提供商配置是否就绪（就绪返回 `200`，未就绪返回 `503`），不泄露敏感密钥，也不依赖上游网络连通性。
- **端侧智能修复 (Smart Erase)**：基于 onnxruntime-web（WebGPU 优先，WASM 降级兜底）在 Dedicated Worker 中完全于设备本地运行 MI-GAN 图像修复流水线（`migan_pipeline_v2.onnx`，26.8 MB，MIT 许可），仅对遮罩区域像素进行重绘合成，遮罩外像素 100% 原样保留，图片无需上传。
- **一键去隐形水印**：扫描原图溯源凭证（`POST /api/v1/provenance/openai`），执行容器级元数据擦除（C2PA/EXIF/XMP 剥离，像素零损耗）；若检测到 Google SynthID 等像素级不可逆隐形水印，诚实呈现检测结果并引导至换源重绘模式。
- **账号与多端同步**：支持邮箱验证码注册与登录（`POST /api/v1/auth/email-code`），基于 HttpOnly Cookie 维持会话，凭据令牌永不暴露给前端 JavaScript。

---

## 本地运行

```bash
npm install
npm test
npm run build
npm run server
npm run dev
```

生产环境构建产物为纯静态资源。后端 Fastify 适配器可通过 `npm run server` 独立启动，本地默认监听 `127.0.0.1:8787`，并在服务端直接读取 `OPENAI_API_KEY`。在本地开发时，Vite 会自动将 `/api` 请求代理到该本地服务。

---

## 凭据网关组件 (Provenance Gateway)

`providers/content-provenance-gateway/` 是本仓库内的独立单文件服务：基于 Node 构建，将 OpenAI 的 `POST /v1/content_provenance_checks` 包装为匿名端点（内置 IP 限流、每日成本熔断与并发限制）。

克隆仓库：

```bash
git clone https://github.com/dengyie/one-image.git
```

---

## 架构布局

```text
src/domain/          纯业务契约与状态机状态转换
src/application/     文件安全策略与用例编排
src/infrastructure/  浏览器图像底层处理与供应商适配器
src/App.tsx          UI 展示层与交互大盘
tests/               Vitest 单元与行为回归测试
providers/           独立部署的凭据溯源网关服务
```

---

## 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
