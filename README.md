# @shenyue/dsh-brain

把「AI 助手的大脑」做成 4 个 **DSH 原生 Host 插件**：自动采集 DSH 自己的会话，后台静默整理成
长期记忆，再把相关的原文/情节按需捞进 DSH 自己的 system prompt。不接桌宠、不监听任何端口、
不发任何外部请求、**不压缩也不改写 DSH 会话历史**。

| 插件行 | 层 | Service | 作用 |
|---|---|---|---|
| `dsh-memory` | 记忆层（长期记忆） | `brainMemory` | 双向长期记忆：`user` 侧（关于用户/「你」）+ `self` 侧（关于助手自己/「我」）；原文 + 事实 + 情节索引 + 摘要 |
| `dsh-mood` | 情绪层 | `brainMood` | 双向情绪：用户的 valence/energy、助手自己的 valence/energy/affection/status |
| `dsh-persona` | 人格收集层 | `brainPersona` | 双向倾向：用户沟通风格 + 助手表达倾向，随对话演化并回归基线 |
| `dsh-context` | 上下文整理层 | `brainContext` | 后台消化（压入长期记忆）+ 每轮工作记忆召回（捞出相关原文）；`/brain` 命令 |

## v2.1.0：角色隔离 + 召回自学习

用户要求：系统注入/代理消息不能混进「你以前说过」；召回层要像人一样，从「这条记忆后来被用上了吗」
里学会怎么召回（用户在 11-21 说「记忆是你的，召回层应该也会自学习去学怎么召回」）。

- **角色隔离（`src/roles.js`）**：按 message 的 `role` / `source.kind` + 文本特征
  （`Time sampled while`、`Browser time zone`、`Elapsed since`、`Agent … sent a message`、
  `Background subagent … finished`、`[已归档到记忆库`、system prompt 注入块）把消息判成
  user / assistant / system；system **永不进 user 侧**、不参与「你以前说过」召回。
  `memory_turns.origin` 记录来源；历史库里的 system 行在 schema 5 迁移时迁到
  `memory_events`（附 `salience:0.05`），清洗前后有 `turns-origin-migrated` 日志。
  新增 `includeSystemEvents:false`：默认只隔离不存，开启后系统/工具事件才落 `memory_events`。
- **召回自学习（`src/learning.js`，默认开）**：
  - 归因：本轮注入的片段出现在**下一轮 user 文本**（满分）才算 used；只出现在助手回复里算
    echo（0.5，归因时按 ignored 处理，不给 term 加权），都没有算 ignored。
    `recallLearningMode:'rule'` 零模型调用；`'llm'` 是低预算 judge，单轮最多 1 次。
  - 单条记忆 usefulness 用 EMA（α=0.3）；term 权重 used ×1.05 / ignored ×0.95（lr=0.05），
    clamp [0.1,3]，每天 ×0.95 向 1 回落；全局特征权重（relevance/salience/recency/topic/affection）
    用预测分与实际 use 的小步误差更新。
  - **遗忘信号**：user 文本命中 `/你忘了|不记得|之前说过|上次|我记得|忘了吗/` 时，把该句 +
    上一轮主题词写进 `recall_misses`，相关 term ×1.5，下一轮召回自然更强。
  - 打分 = 原公式 × 学到的 term/feature 权重；注入格式不变（原文片段 + 时间 + turn id）。
  - 全部失败静默只写日志；`recallLearningEnabled:false` 一键关闭（不写任何 `recall_*` 表）。
- **观测**：`/brain learn`（命中率 / top 学到的词 / 最近 misses / 特征权重）、
  `/brain recall <q>`（相关/重要/话题/新近/学习词 各贡献）、`snapshot().learning`、
  `brain-db learn`；schema 5 新增 `memory_events` + 4 张 `recall_*` 表。

## v2.0.0：全存 + 归档 + 话题召回

用户定义：**记忆库全存原文**；插件把「已确认在记忆库」的旧轮次从当前会话里移除（换成一条极短标记），
需要时再按话题把原文片段召回。

- **全存**：`memory_turns` 保存 user/assistant 完整原文（`maxTextChars` 默认 20000/条，可调大），
  `fetchTurn(id)` / `fetchRange` / `searchTurns` 随时精确取回；episode 只是索引。
- **归档**（`src/archiver.js`，镜像 DSH compaction 的安全 surface 替换）：
  `turn/end` 后按完整 turn + tool 配对平衡选段，**先落库并逐条读回校验**，再用
  `session.append('user/message', marker, { surfaceOp:{op:'replace', startSeq, endSeq},
  sourceEventSeqs })` 把旧段替换成 `[已归档到记忆库：N 轮 · 时间 · 可检索]`。
  保留最近 `keepRecentTurns` 轮 + 当前轮；**不调 compaction、不写摘要**。
  默认 `archiveEnabled:false` / `archiveDryRun:true`（机制已用 scratch 会话验证，默认交给用户打开）。
- **话题召回**（`src/context.js` + `memory.recallOriginals`）：字符 bigram + IDF + 时间衰减 + 归档加成，
  最近 1–2 轮判断话题连续性；与当前话题无关的归档段不注入，用户点名关键词时强加权；
  注入原文片段（≤120 字，带时间 + turn id），每轮 ≤`recallLimit`（4）条、预算 `recallMaxChars`（1200）、
  3 轮内不重复。
- **命令**：`/brain recall <关键词>`（看召回分数）、`/brain memory <关键词>`（列原文）、
  `/brain`（归档轮数/开关）。

## v1.2.0：后台消化（压入长期记忆）

用户要的不是「压缩」，是**记忆分流**：后台把表意识里的东西静默压入长期记忆，需要时再从
长期记忆把相关记忆捞到工作记忆。

- **后台消化（`src/consolidator.js`）**：`turn/end` 累计 `consolidateEveryTurns` 轮或空闲
  `idleConsolidateMs` 后触发；只读 `session/event` 与 `memory_turns`，产出事实 + 情节记忆
  （≤160 字小摘要 + 原文 turn 指针 + 当时 mood + salience）+ 滚动摘要，然后把轮次标记
  `consolidated = 1`。**原文永远保留**（`memory_turns`），不删、不改、不写任何会话事件。
- **工作记忆召回（`src/context.js`）**：每轮按「最新输入 + 最近两轮」检索 facts / episodes /
  旧对话原文 / 摘要，打分 = 相关度 + salience + 时间衰减（好感度高时关系类情节加权），
  3 轮内不重复注入（被再次提到会刷新），预算 `workingMemoryMaxChars`（默认 1200），按
  「画像事实 > 相关记忆 > 摘要 > 情绪/人格」裁剪，总长 `maxChars`（默认 1800）。
- **原文可精确取回**：`brainMemory.fetchTurn(id)` / `fetchRange(sessionId, fromSeq, toSeq)` /
  `searchTurns(query, {sessionId, since, until, limit})`；episode 只是索引，原文永远取得到。
- **可观测**：`/brain` 显示长期记忆/上次整理/本轮注入；`/brain memory` 列出情节；
  `/brain memory <关键词>` 按关键词列原文（截断展示）；`/brain consolidate` 立即整理一次。

- **自动采集**：监听 `session/event`（post-commit 只读投递），把「用户消息 + 助手回复」
  配对成轮，喂给三层；默认跳过 subagent 子会话、按正则过滤、超长截断、按 seq 幂等。
- **自动注入**：`ctx.systemPrompt.section({ name: 'dsh-brain:context', order: 100, text })`
  每次组装 prompt 现算；任何异常返回空字符串；`enabled: false` 时不注册。
- **零依赖**：只用 Node 内置模块 + DSH 服务（`ctx.llm` 仅用于低频摘要/事实补充）。
- **可单层启停**：四个行各自独立 config，任一层停用不会拖垮其它层或注入本身。
- **数据**：`%USERPROFILE%\.dsh\dsh-brain\` 下的 **SQLite** 数据库 `brain.db`
  （`node:sqlite`，WAL，schema 5；表：memory_turns / memory_facts / memory_episodes /
  memory_archives / memory_events / memory_summaries / recall_item_stats /
  recall_term_weights / recall_misses / recall_feature_weights / mood_state / mood_history /
  persona_traits / persona_baseline / collector_state / collector_pending），另有 `brain.md` 镜像与 `brain.log` 日志。
  旧 v1.0.0 JSON 会在首次打开时自动导入并改名 `*.imported-<ts>`。
- **核查工具**：`node tools/brain-db.mjs stats|turns|facts|mood|persona|learn|sql`；
  `node tools/verify-learning.mjs`（临时库 + 合成 user 事件，一键复现 used/ignored、权重上浮、
  miss、分数上升与 echo 回落）；`node tools/session-surface.mjs <session.v4.jsonl.zstd>`
  （只读统计 surface 节点/替换次数）。
- **命令**：`/brain`（总览）、`/brain memory`（含采集诊断与情节）、`/brain memory <关键词>`
  （按关键词列原文）、`/brain recall <关键词>`（召回打分 + 学习词倍率）、`/brain learn`
  （召回学习命中率/top 词/miss/特征权重）、`/brain mood`、`/brain persona`、
  `/brain consolidate`（立即整理一次）、`/brain reset confirm`。
- **诊断**：`collect-skip` / `collect-filtered` 日志默认开启（只记原因与长度，不记内容）；
  `debugSection: true` 可让注入文本每次组装时打 `section-text` 日志。

完整说明见 [docs/DETAIL.md](docs/DETAIL.md)；离线自测见 [test/README.md](test/README.md)。

```powershell
# 从本地目录安装（Plugin Manager 的 Plugins > Add plugin 也可以）
plugin_manager install_bundle target=Z:\dsh-restore\dsh-plugin\dsh-brain
```

