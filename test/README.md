# 自测

不依赖 DSH、不联网：用 `fs.mkdtemp` 建临时目录（SQLite 临时库）+ 极简假 Cordis ctx
（`get` / `provide` / `effect` / `on` / `emit` / `inject`）、假 `systemPrompt`、
假 `commands`、假 `llm` 装载四个插件行，模拟 `session/event` 投递。

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
& $node test\smoke.mjs      # 149 项：存储/采集/记忆/情绪/人格/上下文/命令/降级
& $node test\e2e.mjs        # 14 项：整理→角色 bootstrap→实体抽取→注入 全链路
& $node test\entity.test.mjs      # 22 项：实体层（抽取/关联/扩散/槽位/结构化字段）
& $node test\character.test.mjs   # 10 项：角色层（版本化存储/降级）
& $node test\role.test.mjs        # 11 项：域角色（通用规范）
```

## 端到端（v2.3.0，`test/e2e.mjs`）

假模型按 system prompt 判断"这次是谁在调"（角色 / 实体抽取 / 摘要 / 情节），
然后把整条链跑一遍：

- 两轮医患对话 → `turn/end` 触发后台整理；
- 整理顺带 bootstrap 角色（模型写「我是谁」）、结构化抽取患者字段（主诉/处方）；
- 再算注入：`【我是谁】` + `【当前对象 · 张三】` 都在，且角色段 order 在上下文段之前；
- 表意识槽位：「他今天怎么样」接回张三；激活扩散：提到张三时带出李四。

**这组测试证明"不装也能验证"**：插件装进 profile 前，整条链已经在这个假 Host 上跑通过。

覆盖（149 条断言，当前全过；跑完自动删除临时目录）：

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

## 实体层（v2.3.0，`test/entity.test.mjs`）

```powershell
& $node test\entity.test.mjs
```

- 规则抽取：身份前缀（患者/病人/客户/项目/宠物）、敬称后缀、敬称算代号（王先生）；
  `今天天气不错` 这类普通句子**不产生对象**
- 存储：`upsert` 幂等（按归一化名字）、按名字/别名查找、`ingestTurns` 抽实体 +
  关联轮次 + 记要点（含"只提到名字"的既有对象）
- `resolveMentions`：本轮提到谁；渲染「当前对象」段与超预算截断

## 角色层（v2.2.0，`test/character.test.mjs`）

```powershell
& $node test\character.test.mjs
```

- 定义去围栏/去标题/限长；无模型兜底只写看得见的事实（不编造性格）
- bootstrap / revise 的 messages 形状；渲染「没定义不注入、有定义带标题」
- 存储：`ensure` 幂等建 v0 → `save` 产生 v1 + 历史 → 攒不够证据不修订、够了才修订
- 改名不动版本与定义；空定义拒绝保存
- 模型不可用 → 写规则兜底定义并标 `fallback`（走 `runCharacterStep` 全链路）

## 域角色层（v2.2.0，`test/role.test.mjs`）

单独一支，纯函数、不需要 DSH 与数据库：

```powershell
& $node test\role.test.mjs
```

- `空配置 → 空角色，不注入`：默认不会凭空多出一段 system prompt
- `垃圾输入被收敛，不抛异常`：非字符串、重复项、超长、列表上限
- `注入文本包含该有的段`：角色 / 画像 / 规范 / 红线 / 红旗 / 不确定策略
- `预算再紧也不丢红线与规范`：`maxChars` 压到 200 时只丢画像项
- `可以从实体上关掉共享记忆说明`（多患者场景默认要它）
- `缺 uncertainty 时给默认兜底策略`
- `dsh-context 接受 role 三项且不报未知配置`
- `默认关闭域角色`
- `/brain profile` 摘要条目数、注入段名字固定

