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

## noha：真实数据尚未修改

noha 的正式历史迁移命令尚未获设备的执行许可；
此前仅在独立数据副本上通过了迁移与恢复演练。
不能把 noha 计为正式迁移成功。

## 客户端核验边界

Provider 和 SQLite 元数据迁移不自动保证客户端可列出、
打开或续接会话，尤其是 `.jsonl.zst` 历史。
6v 上的 `scripts/probe-live-appserver.mjs` 用于执行只读
`thread/list`、`thread/read` 测试；其实际结果需另行记录。
即使本地 App Server 读取通过，仍不能直接推定
Codex Remote 图形界面的显示行为。
