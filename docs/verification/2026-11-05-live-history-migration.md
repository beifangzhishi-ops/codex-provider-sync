# 双机正式历史 Provider 迁移记录（2026-11-05）

## 执行边界

迁移目标是把历史会话的 `model_provider` 收敛到内置小写
`openai`；不改写消息正文、历史模型 ID、鉴权凭据或 CMP 服务。
在每台真实数据修改前，先生成工作区 Git 忽略目录内的原始
会话文件副本、SQLite 在线备份及元数据完整性基线。
仅当源与备份全部哈希比对通过、没有未完成事务时才执行同步。
同步工具另行生成受管理的 UndoBackup，独立原始备份持续保留。

## 6v：已完成并通过独立校验

| 项目 | 结果 |
| --- | ---: |
| 迁移前会话文件总数 | 577 |
| 迁移前 SQLite 线程 | 563 |
| 迁移候选会话 | 570 |
| 实际同步会话 | 570 |
| 实际更新 SQLite 线程 | 558 |
| 跳过 | 0 |
| 部分失败 | 否 |
| 迁移后 SQLite Provider `openai` | 563 / 563 |
| 文件缺失 / 新增 | 0 / 0 |
| 解压后正文变化 | 0 |
| 非 Provider 头字段变化 | 0 |
| SQLite 非 Provider 字段变化 | 否 |
| 独立完整性状态 | verified |

迁移前 SQLite 的 Provider 计数：`OpenAI=554`、
`deepseek=4`、`openai=5`；迁移后为 `openai=563`。
本轮包含隔离演练之后新产生的一条会话，所以正式检查的总数
与之前演练的 576 文件、562 线程不同。

6v 的原始备份位于该设备本地 Git 忽略的
`.tmp-community-provider-sync/.local-live-migration/` 下，
另有工具生成的独立 UndoBackup。原始备份未复制 `auth.json`。
备份内容、个人会话正文、文件明细与凭据均不应提交至 Git。

## noha：已完成并通过独立校验

| 项目 | 结果 |
| --- | ---: |
| 迁移前会话文件总数 | 1,525 |
| 迁移前 SQLite 线程 | 1,481 |
| 迁移候选会话 | 1,485 |
| 实际同步会话 | 1,485 |
| 实际更新 SQLite 线程 | 1,443 |
| 跳过 | 0 |
| 部分失败 | 否 |
| 迁移后 SQLite Provider `openai` | 1,481 / 1,481 |
| 文件缺失 / 新增 | 0 / 0 |
| 解压后正文变化 | 0 |
| 非 Provider 头字段变化 | 0 |
| SQLite 非 Provider 字段变化 | 否 |
| 未完成事务 | 0 |
| 独立完整性状态 | verified |

迁移前 SQLite Provider 计数：`OpenAI=1425`、`openai=38`、
`deepseek=12`、`openai_http=1`、`team-proxy=2`、`cpa=3`。
迁移后为 `openai=1481`。原始会话备份与同步工具的 UndoBackup
分别保留在 noha 的本地 Git 忽略目录及 Codex 数据目录中。

## 客户端核验边界

Provider 和 SQLite 元数据迁移不自动保证客户端可列出、
打开或续接会话，尤其是 `.jsonl.zst` 历史。
用户已反馈：6v 重装 Codex 后，手机端能看到历史会话。
这属于 6v 的实际客户端可见性验证，不等于逐个会话都已打开或续接。
noha 的客户端显示与续接尚未实测。
`scripts/probe-live-appserver.mjs` 提供只读 `thread/list`、
`thread/read` 测试；它不能替代客户端端到端续接检查。
