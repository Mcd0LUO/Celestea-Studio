# celestea_studio · `docs/` 索引

> 本页是 `/src/celestea_studio/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态三分类：**当前** = 与现状同步；**设计** = 目标设计（未必已实现）；**历史** = 已归档，只存史不再更新。

## 先说仓库角色（2026-09-11）

- 本仓**现役** = **线上前端（`frontend/`）+ 共享数据文件**（`workspaces.json` / `providers.json` / `prompts.json` / `sessions/`）。
- 本仓 **Rust Studio 后端已退役**（`celestea-studio.service` 已 masked）：见 [`../LEGACY-RUST-BACKEND.md`](../LEGACY-RUST-BACKEND.md)。
- **后端开发（TypeScript，生产）在 [`/src/celestea_studio-ts`](/src/celestea_studio-ts/docs/README.md)**；
  Rust **引擎**参考实现在 [`/src/celestea_harness`](/src/celestea_studio/docs/archive/harness/README.md)。
- 因此本仓 `docs/` 里凡是描述 Rust 后端的文档一律归 **历史**（2026-09-11 归档进 [`archive/`](./archive/)，正文保留 + 顶部 📦 横幅），
  只有前端规则与数据文件格式仍属当前。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 当前（Rust 后端部分为历史参考） | Rust 期开发者权威入口：架构总览、模块职责表、关键机制（Gen/swap_gen、SSE 信封、autowake、提示词装配）、开发工作流、测试现状与文档索引 | 本文自身的 §0 文档地图；后端开发改看 [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件** schema 与格式：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`（写作时基于 Rust 实现；TS 后端读写同一批文件） | 本文；字段变更以 TS 侧实现与 `/src/celestea_studio-ts/contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | 踩坑档案：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证（每条来自真实修复）；前端渲染与数据文件类条目**仍适用** | 本文 |
| [`archive/backend-language-eval.md`](./archive/backend-language-eval.md) | 历史 | W229（2026-09-07）后端语言切换评估，结论「维持 Rust axum 不换语言」——已被 TS 全量重写推翻 | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/backend-ts-rewrite-eval.md`](./archive/backend-ts-rewrite-eval.md) | 历史 | W268 Rust → TypeScript 全量重构评估 + 可执行迁移计划（迁移已完成，本报告为立项依据） | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/api-contract.md`](./archive/api-contract.md) | 历史 | 已退役 Rust 后端（axum）全部 HTTP 端点契约：39 端点 / 请求响应 / 每个错误分支的 status + error 原文 | [`/src/celestea_studio-ts/contracts/endpoints.json`](/src/celestea_studio-ts/contracts/endpoints.json)（43 端点） |
| [`archive/deployment.md`](./archive/deployment.md) | 历史 | 已退役 Rust 后端的 systemd / nginx / 环境变量 / 健康检查 / 重启与回滚（来自机器实际配置） | [`/src/celestea_studio-ts/scripts/run-studio-ts.sh`](/src/celestea_studio-ts/scripts/run-studio-ts.sh) + TS 仓文档 |
| [`archive/frontend-session-persistence-eval.md`](./archive/frontend-session-persistence-eval.md) | 历史 | 「刷新后聊天消失」评估：后端已持久化，缺口在前端启动恢复（推荐方案 A，已实现） | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| [`archive/prompt-injection-eval.md`](./archive/prompt-injection-eval.md) | 历史 | 提示词变量注入 / 多提示词注册评估（Rust 期 `src/prompts.rs`）；机制已在 TS 后端落地 | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| [`archive/frontend-freeze-stop-button-plan.md`](./archive/frontend-freeze-stop-button-plan.md) | 历史 | 前端卡死修复 + statusline 停止按钮架构方案（W301/W302），方案已上线，文首「待执行」已过时 | [`DEVELOPMENT.md`](./DEVELOPMENT.md)、[`pitfalls.md`](./pitfalls.md) |

`docs/` 下**没有**其它文件：保留 3 篇（`DEVELOPMENT.md` / `data-files.md` / `pitfalls.md`）+ `archive/` 7 篇历史。
仓根另有两份面向仓库整体的文档：[`../README.md`](../README.md)（运行 / API / 文档索引）、
[`../LEGACY-RUST-BACKEND.md`](../LEGACY-RUST-BACKEND.md)（Rust 后端退役与回滚）。

## 仓库角色与互链

| 仓库 | 角色 | 文档入口 |
| --- | --- | --- |
| `/src/celestea_studio`（本仓） | 线上前端 + 共享数据文件（Rust 后端已退役） | 本页 / [`../README.md`](../README.md) |
| `/src/celestea_studio-ts` | Studio 后端（TypeScript，**生产**） | [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md) |
| `/src/celestea_harness` | Rust **引擎**参考实现 | [`/src/celestea_studio/docs/archive/harness/README.md`](/src/celestea_studio/docs/archive/harness/README.md) |

## 维护约定

- 新增文档 → 在本页表格登记（文件 / 状态 / 一句话 / 权威入口），并同步 [`../README.md`](../README.md) 与
  [`DEVELOPMENT.md`](./DEVELOPMENT.md) §0 文档地图。
- 文档过时 → 移入 `archive/`（`git mv` 保历史）+ 顶部 `📦 历史文档` 横幅 + 更新本页状态与全仓引用路径；**不删除正文**。
- 归档不等于作废：`archive/` 里的报告是「为什么这样设计」的决策留痕，追溯时仍应读。
