# 自测

不依赖 DSH、不联网：用 `fs.mkdtemp` 建临时目录（SQLite 临时库）+ 极简假 Cordis ctx
（`get` / `provide` / `effect` / `on` / `emit` / `inject`）、假 `systemPrompt`、
假 `commands`、假 `llm` 装载四个插件行，模拟 `session/event` 投递。

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
& $node test\smoke.mjs
```

覆盖（67 条断言，当前全过；跑完自动删除临时目录）：

## SQLite 存储（v1.1.0 新增）

- `db.single-shared-connection`：四层共享同一个 `DatabaseSync` 连接（引用计数单例）
- `db.file-created` / `db.tables-created` / `db.schema-version`：建表幂等 + meta/user_version=1
- `db.turn-write-query`：写入并查询轮次
- `db.unique-session-seq`：同一 `(session_id, seq)` 重复写入不重复（采集幂等）
- `db.transaction-rollback`：事务内抛错回滚，不留下脏数据
- `db.fact-norm-unique-merge`：事实 `UNIQUE(side, norm)` 兜底 + 相似度合并
- `db.max-turns-prune`：超过 `maxTurns` 自动删最旧轮次
- `db.connection-released` / `db.reopen-persists`：退出释放连接、重开后数据仍在
- `db.side-isolation`：user / self 两侧数据隔离
- `db.no-json-files`：不再写 memory.json / mood.json / persona.json / state.json
- `migrate.json-to-db` / `migrate.files-renamed` / `migrate.idempotent` / `migrate.collector-seq`：
  旧 JSON 幂等导入、文件改名 `*.imported-<ts>`、重复导入不重复
- `db.reset-backup-file`：`/brain reset confirm` 前生成 `brain.db.bak-<ts>`
- `db.pending-user-persisted` / `db.pending-survives-reload` / `db.pending-cleared-after-pair`：
  用户消息在等助手回复期间持久化，插件重载后仍能配对（v1.1.1 修复「人类消息丢失」）
- `collector.skip-no-pending`：孤立 assistant 不会配成轮，统计里出现 `no-pending-user`
- `collect.subagent-agent-message-accepted`：`collectSubagents` 开关决定是否接受 agent-message 来源

## 采集

- `collect.pairs-turn`：user/message + assistant/message 配对成一轮
- `collect.filters`：subagent 会话 / id 命中 `pet` / 过短消息 / 合成注入消息跳过
- `collect.session-included-rules`：include/exclude/subagent 规则
- `collect.truncate`：超长消息截断到 `maxTextChars`
- `collector.direct-events`：采集器直测（未配对的助手消息不记一轮）

## 记忆

- `facts.user-extract-profile-project`、`facts.user-ignore-question`、`facts.self-promise`
- `facts.similarity-threshold`、`facts.pure-max-cap`
- `facts.extracted-after-interval`、`facts.self-relation`、`memory.profile-name`
- `memory.remove-fact`、`memory.dual-summary-db`、`memory.summary-row-count`、`facts.llm-supplement`

## 情绪

- `mood.decay-toward-baseline` / `mood.decay-skip-fresh`：过期才衰减、新鲜不动，深夜惩罚
- `mood.user-energy-drop`、`mood.self-affection-up`、`mood.history-db`

## 人格

- `persona.self-warmth-on-praise`、`persona.user-detail`、`persona.daily-regression`
- `persona.bounded-negativity`、`persona.render-natural-language`、`persona.both-sides-db`

## 上下文

- `context.build-text`、`context.section-registered`、`context.section-text-content`
- `context.error-returns-empty`（异常 → `''`）、`context.disabled-no-section`
- `degrade.context-still-injects`

## 命令

- `command.overview`、`command.memory-reads-db`、`command.mood`、`command.persona`
- `command.reset-needs-confirm`、`command.reset-confirm-db`、`command.unknown`、`command.definition-shape`

## 降级

- `services.provided`：四个 Service 全部注册
- `degrade.mood-disabled-memory-collects`：单层停用不影响其它层

