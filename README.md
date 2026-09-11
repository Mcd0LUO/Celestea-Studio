# Celestea Studio

Local web UI for the Celestea-Agent engine (celestea-runtime). A single Rust
binary serves a dark-mode chat UI and streams engine turn events over SSE.

## Run (local)

export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
cd /src/celestea_studio
cargo build --release
CELESTEA_API_KEY=sk-... ./target/release/celestea-studio          # 127.0.0.1:3777

Config: celestea.toml in cwd (model / base_url / api_key_env), same rules as
the engine; API key via CELESTEA_API_KEY env, api_key_file, or ~/.celestea
config. No key is stored in this repo.

## Access via tunnel

ssh -L 3777:localhost:3777 <server>
# then open http://localhost:3777

## API

- GET / and GET /assets/* - frontend (embedded at compile time)
- POST /api/turn {"input":"..."} - start one turn (409 while busy)
- POST /api/cancel - cooperative cancel of the running turn
- GET /api/events - SSE stream (event names: status/text/thinking/tool/tool_result/done)
- GET /api/health - {ok, name, model, base_url, bind}

## Docs / 仓库角色

> 本仓现役 = **线上前端（`frontend/`）+ 共享数据文件**（`workspaces.json` / `providers.json` / `prompts.json` / `sessions/`）。
> **Studio 后端开发（TypeScript，生产）见 [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md)**；
> Rust **引擎**（参考实现）见 [`/src/celestea_harness/docs/README.md`](/src/celestea_harness/docs/README.md)。
> 本仓 Rust 后端已于 2026-09-11 退役：见 [`LEGACY-RUST-BACKEND.md`](LEGACY-RUST-BACKEND.md)。

- **[docs/README.md](docs/README.md)** — `docs/` 全量索引：每份文档的**状态（当前 / 设计 / 历史）**、一句话、权威入口。
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Rust 期开发者权威入口（架构总览、模块职责表、关键机制、工作流、测试现状）。**后端已退役，本文属历史参考。**
- [docs/data-files.md](docs/data-files.md) — 共享数据文件 schema：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl`（TS 后端读写同一批文件）。
- [docs/pitfalls.md](docs/pitfalls.md) — 踩坑档案（每条来自真实修复），前端与数据文件相关条目**当前仍适用**。
- [docs/archive/](docs/archive/) — **历史文档**（2026-09-11 归档，只存史）：Rust 期 API 契约、部署、语言/重构评估、前端方案。
- [frontend/FRONTEND-RULES.md](frontend/FRONTEND-RULES.md) — 前端渲染铁律（验收硬性标准，**当前仍适用**）。

> 改动生效方式：前端 `cd frontend && pnpm build`（无需重启）；后端 `cargo build --release` + `sudo systemctl restart celestea-studio`。
