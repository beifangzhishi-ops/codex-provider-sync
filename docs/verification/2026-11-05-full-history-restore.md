# 双机历史会话 Provider 同步与完整恢复演练（2026-11-05）

## 范围与边界

在 noha 和 6v 各自的仓库内使用独立的 `.local-history-lab` 数据副本。
使用 `scripts/rehearse-history-snapshot.py` 建立快照，
`scripts/rehearse-history-integrity.mjs` 建立迁移前校验基线，
执行 Provider-only 同步，然后用独立 UndoBackup 执行一次性
`restore-rehearsal`。两台均记录了 `restoreJournalState: completed`。

恢复后重新运行 `rehearse-history-integrity.mjs restore`，对比全部
rollout 文件的解压后消息正文、非 provider 会话元数据、历史 provider 分布，
以及 SQLite 线程的非 provider 字段。确认无未完成的恢复事务。
不记录或提交任何会话正文、路径明细、凭据或原始备份。

## 实测结果

| 核验 | noha | 6v |
| --- | ---: | ---: |
| 全部会话文件 | 1,525 | 576 |
| Restore 实际修改会话文件 | 1,485 | 570 |
| Restore 目标（含 SQLite） | 1,486 | 571 |
| SQLite 线程数 | 1,481 | 562 |
| 缺失、额外文件 | 0、0 | 0、0 |
| 解压后正文变化 | 0 | 0 |
| 非 provider 会话头变化 | 0 | 0 |
| provider 与迁移前不一致 | 0 | 0 |
| SQLite 非 provider 字段变化 | 否 | 否 |
| 未完成事务 | 0 | 0 |
| Restore 最终状态 | completed | completed |

恢复后的 SQLite provider 分布：

- noha：`OpenAI=1425`、`openai=38`、`deepseek=12`、
  `openai_http=1`、`team-proxy=2`、`cpa=3`。
- 6v：`OpenAI=554`、`deepseek=4`、`openai=4`。

之前发现并修复了两个 Restore 误报：读取工作数据库时空 WAL/SHM
触发错误的 `state-db` 修订变化，以及读取备份源时生成 SQLite sidecar
触发错误的 `backup` 源变化。最终演练均未再触发这些错误；
备份源快照仍通过严格的文件内容校验。

## 尚未验证

本演练证明独立副本可以批量同步、批量恢复并与迁移前保持内容一致；
**不代表真实 `~/.codex` 历史已迁移**。本次没有修改真实历史目录、
鉴权文件或 CMP 服务。Codex Remote 能否显示、打开和继续这些历史会话，
仍需单独进行实际客户端验证，不能用 Provider 元数据一致性代替此结论。
