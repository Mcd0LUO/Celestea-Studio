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

## Docs

- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — 开发者权威入口：架构总览、模块职责表、关键机制（Gen/swap_gen、SSE 信封、autowake、提示词装配）、开发工作流、测试现状与文档索引。
- [docs/api-contract.md](docs/api-contract.md) — 全部 HTTP 端点契约（请求/响应/错误码与错误原文）。
- [docs/data-files.md](docs/data-files.md) — `workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` 的 schema 与格式。
- [docs/pitfalls.md](docs/pitfalls.md) — 踩坑档案（每条来自真实修复）。
- [docs/deployment.md](docs/deployment.md) — systemd / nginx / 环境变量 / 健康检查 / 重启与回滚。
- [frontend/FRONTEND-RULES.md](frontend/FRONTEND-RULES.md) — 前端渲染铁律（验收硬性标准）。

> 改动生效方式：前端 `cd frontend && pnpm build`（无需重启）；后端 `cargo build --release` + `sudo systemctl restart celestea-studio`。
