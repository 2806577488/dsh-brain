# DSH 助手大脑（@shenyue/dsh-brain v2.1.0）

v2.1.0 的核心：**角色隔离（系统/代理消息永不进 user 侧）+ 召回自学习（从「有没有被用上」
里学 term / 特征权重，并记住「你忘了」的 miss）**。

- 角色判定在 `src/roles.js`：message 的 `role` / `source.kind`（`runtime-context`、
  `agent-message`、`system-prompt` 等）与文本特征（`Time sampled while`、`Browser time zone`、
  `Elapsed since`、`Agent … sent a message`、`Background subagent … finished`、
  `[已归档到记忆库`、system prompt 注入块）一起判成 user / assistant / system。
  system 不配成 turn、不进「你以前说过」；`memory_turns.origin` 落库。
- schema 5：新增 `memory_events`（系统/工具事件隔离区，`salience:0.05`）与 4 张学习表
  `recall_item_stats` / `recall_term_weights` / `recall_misses` / `recall_feature_weights`；
  历史轮次在打开时按内容清洗（`turns-origin-migrated` 日志给出 user/system/events 数字）。
- 学习在 `src/learning.js`：`attributeUse`（rule；只有下一轮 user 确认才 used，助手复述算 echo
  且按 ignored 处理，防自我强化）、`judgeAttribution`（llm，单轮最多 1 次）、usefulness EMA（α=0.3）、
  term ±0.05 且 clamp [0.1,3] / 每天 ×0.95 回归 1、特征权重小步误差更新、遗忘信号 miss + ×1.5。
  召回打分 = 原公式 × 学到的 term/feature 权重；`recallLearningEnabled:false` 一键关闭。
- 观测：`/brain learn`、`/brain recall <q>` 明细、`snapshot().learning`、`brain-db learn`；
  一键复现：`node tools/verify-learning.mjs`（临时库 + 合成 user-source 事件）。

v2.0.0 的核心：**记忆库全存原文 + 归档（把已全存的旧轮次从当前会话 surface 换成一条标记）+
话题召回（按当前话题把原文片段捞回上下文）**。归档镜像 DSH `dsh-compaction-basic` 的安全
surface 替换（`session.append(..., { surfaceOp:{op:'replace', startSeq, endSeq}, sourceEventSeqs })`），
但**不调用 `compaction`、不生成摘要、不丢原文**。默认 `archiveEnabled:false`、`archiveDryRun:true`。

给 DSH 助手加一层「会记、会有状态、会积累偏好」的大脑，全部长在 DSH 自己的机制上：
监听 DSH 的 `session/event` 自动采集，注册 `systemPrompt.section` 自动注入。
**不接桌宠、不开 HTTP 端口、不依赖任何外部服务。**

## 四层

三长一短：前三层是**长期记忆面（潜意识）**，第四层是**工作记忆面（表意识 = 当前上下文）**。

| 行 id | 层 | Service | 数据文件 |
|---|---|---|---|
| `dsh-memory` | 长期记忆 · 原文/事实/情节 | `brainMemory` | `brain.db`（+ `brain.md` 镜像） |
| `dsh-mood` | 长期记忆 · 情绪 | `brainMood` | `brain.db` |
| `dsh-persona` | 长期记忆 · 双向倾向 | `brainPersona` | `brain.db` |
| `dsh-context` | **工作记忆（当前上下文）** | `brainContext` | 无（读三层 + 写 `brain.log`） |

> 第 4 层不是「往 system prompt 里塞点字」这么窄：它**决定这一轮模型看到什么** ——
> 召回是往里加，归档是把旧轮次从上下文里搬走（换成一行标记）。原文不归它管，永远不丢。

共同目录：`%USERPROFILE%\.dsh\dsh-brain\`（每层可用 `dataDir` 单独覆盖）。

## 双向建模（核心语义）

用户原话把两侧定得很清楚：**用户对于记忆是「你」，DSH 对于插件是「我」**。

| | `user` 侧（关于用户 / 「你」） | `self` 侧（关于助手 / 「我」） |
|---|---|---|
| 记忆事实 | 身份画像、偏好、在做的事、约定、事件、沟通风格 | 记下的承诺、关系进展、表达习惯 |
| 记忆摘要 | 关于用户印象的滚动摘要 | 关于助手自己与关系进展的滚动摘要 |
| 情绪 | `valence` / `energy` | `valence` / `energy` / `affection` / `status` |
| 人格 | `directness` / `pace` / `humor` / `detail` | `warmth` / `directness` / `playfulness` / `proactivity` |

两侧分开存储、分开淘汰、分开渲染；事实类型也分开（user：
`profile/preference/project/promise/event/style`；self：`memory/promise/relation/habit`）。

## 架构与时序

```
采集（自动、只读、不阻塞）：
  DSH Session.append(事件)
    └─ post-commit 广播 'session/event'(session, event)
         └─ dsh-memory / dsh-mood / dsh-persona 各自的 collector
              ├─ 过滤（subagent / include-exclude / 合成注入 / 过短 / 超长截断）
              ├─ 配对（user/message + assistant/message → 一轮）
              ├─ seq 幂等（重复投递不重复记账）
              └─ 各层同步记账 → 记忆层再异步做事实抽取 / 滚动摘要（ctx.llm，失败静默）

注入（自动、每次组装 prompt 现算）：
  dsh-system-prompt 组装 → 读取注册的 section
    └─ dsh-brain:context（order 100）
         ├─ brainMemory：user/self 事实（按相关度+权重取 top N）+ 双向摘要
         ├─ brainMood：用户此刻精力/心情 + 助手状态/精力/熟悉度
         └─ brainPersona：用户沟通偏好 + 助手表达倾向
              └─ 拼成 ≤ maxChars（默认 1500）的自然语言段；异常 → ''
```

## 四层 Service API

### `brainMemory`

| 方法 | 说明 |
|---|---|
| `rememberTurn({user, assistant, sessionId, at})` | 记录一轮（采集器回调） |
| `recentTurns(limit)` / `turns()` | 最近 N 轮 / 全部轮次 |
| `fetchTurn(id)` | 按 id 取回一轮**原文**（user/assistant 全文 + sessionId/seq/时间/mood） |
| `fetchRange(sessionId, fromSeq, toSeq)` | 按会话 + seq 区间取回原文（两端包含） |
| `searchTurns(query, {limit, sessionId, since, until})` | 原文关键词检索（bigram + 新近度），返回带 `score` 的轮次 |
| `recentOriginal(limit)` | 最近 N 轮原文（不截断，人工核查用） |
| `unconsolidatedTurns(sessionId, limit)` | 某会话还没被后台消化过的原文轮次 |
| `markConsolidated(ids, {at})` | 标记「已消化」（只改标记，不删原文） |
| `rememberEpisode({sessionId, at, summary, turnIds, mood, salience, terms})` | 写一条情节记忆（索引，幂等） |
| `episodes(limit)` / `recallEpisodes(query, {limit, now})` | 最近情节 / 按相关度检索情节（打分见下） |
| `appendSummary(side, text, {maxChars})` | 把一段内容并进滚动摘要（去重、保尾部） |
| `recall(query, {side, limit})` | 按 bigram 相关度召回原文（`side: user\|self\|both`） |
| `recallOriginals(query, {limit, recentTexts, topicShiftEnabled})` | v2.0.0 原文召回：IDF + 时间衰减 + 归档加成 + 话题连续性；返回 `snippet`/`score` |
| `isNoiseTurn(turn)` | 判断模板化噪声（`Time sampled while…` 等），采集/召回都跳过 |
| `recordArchive(...)` / `markArchived(ids, archiveId)` / `archives(limit)` | 归档记录与标记（原文仍在 memory_turns） |
| `facts(side)` | 某一侧事实；不传 side 返回两侧 |
| `factsForPrompt(side, query, limit)` | 给注入挑事实 |
| `upsertFact({side, text, kind?, weight?})` | 手动新增 / 合并（相似度 ≥0.8 合并） |
| `removeFact(id)` | 删除一条（两侧都找） |
| `summaries()` / `setSummary(side, text)` | 双侧摘要读 / 写 |
| `profile()` | `{userName}`（从「我叫…」里抽） |
| `snapshot()` | `{summaries, facts:{user,self}, profile, recentTurns, events, learning, counts}` |
| `rememberEvent({sessionId, seq, at, kind, text, meta})` / `events(limit)` | v2.1.0 系统/工具事件隔离区（不参与 user 侧召回） |
| `recallLearning()` / `learningStats()` | 学习开关/模式与统计（`/brain learn`、`snapshot().learning`） |
| `recordRecallInjection(items)` / `applyRecallAttribution({items, attribution})` | 注入计数 / 下一轮 used/ignored 归因 |
| `recallFeatureWeights()` / `recallTermFactor(terms)` | 学到的特征权重 / term 倍率（召回打分用） |
| `recordRecallMiss({sessionId, turn, at, terms, sourceText})` / `resetRecallLearning()` | 遗忘信号 miss（含 ×1.5 加权）/ 清空学习数据 |
| `reset({backup})` | 清空记忆（默认备份） |
| 扩展（低频任务） | `dueForFacts()` / `runFactExtraction()` / `dueForSummary()` / `runSummary()` / `getLastSeq()` / `setLastSeq()` |

`Fact = { id, side, text, kind, weight 0..1, createdAt, lastSeenAt, hits }`。

`Episode = { id, sessionId, at, summary, turnIds[], mood, salience 0..1, terms, createdAt }`：
`terms` 是检索用的中文二元组/拉丁词串，`turnIds` 指向 `memory_turns` 原文——**episode 只是索引，
原文永远可以通过 `fetchTurn`/`fetchRange` 精确取回**。

### `brainMood`

| 方法 | 说明 |
|---|---|
| `current()` | `{user:{valence,energy,updatedAt}, self:{valence,energy,affection,status,updatedAt}}` |
| `update({userText, assistantText})` | 先时间衰减、再规则更新两侧，返回 `{user, self, reasons, signals}` |
| `applyTimeDecay(now?)` | 只做时间衰减（超过 `moodDecayMinutes` 才回归，深夜额外扣减） |
| `history(side, limit)` | 某一侧心情轨迹（≤ `historyLimit`） |
| `snapshot()` / `reset({backup})` | 快照 / 重置 |
| 扩展 | `getLastSeq()` / `setLastSeq()`（采集幂等） |

### `brainPersona`

| 方法 | 说明 |
|---|---|
| `traits(side)` | `user`：`{directness,pace,humor,detail}`；`self`：`{warmth,directness,playfulness,proactivity}` |
| `collect({userText, assistantText})` | 收集一轮（有界、每天回归各自基线） |
| `render()` | `{user, self, lines:{user,self}, sections, text}` 自然语言 |
| `baseline()` / `setBaseline({user,self})` | 读 / 覆盖基线 |
| `snapshot()` / `reset({backup})` | 快照 / 重置 |
| 扩展 | `getLastSeq()` / `setLastSeq()` |

### `brainContext`

| 方法 | 说明 |
|---|---|
| `assemble({userText?, sessionId?})` | `{systemSections, text, stats}`（供其它插件/测试） |
| `preview()` | `{text, sections, stats, sectionName, order}` |
| `registerPromptSection()` | 注册 system prompt 段，返回 disposer（未注册返回 undefined） |
| `sectionText()` | 现算注入文本（异常返回 `''`） |

## 自动采集细节

- **事件源**：Host 事件 `'session/event'`，签名 `(session, event)`，post-commit 只读；
  观察者失败被 DSH 包含，不会让会话落盘失败。
- **只消费**：`user/message`（`source.kind === 'user'`）与 `assistant/message`
  （`data.message`），从 `content` 里只取 `text` 块。
- **过滤**：
  - subagent 子会话默认跳过（`header.origin === 'subagent'` / `header.parentSession` /
    `delegationDepth > 0`），可用 `collectSubagents: true` 打开；
  - `excludeSessionIdPattern`（默认 `pet`）同时匹配会话 id 与 `header.cwd`；
  - `includeSessions` 非空时只采集匹配的会话；
  - 合成注入消息（`<system-reminder>`、`AGENTS.md`、`Skill:`、runtime-context 等）跳过；
  - 短于 `minTextChars` 的消息跳过；超长消息截断到 `maxTextChars`（默认 2000）；
  - `source.kind` 不是 `user` 的消息默认跳过（如 runtime-context / repeat-tool-reminder / subagent-settled / agent-message）；
    开启 `collectSubagents: true` 时，子会话里的 `agent-message` / `subagent-settled` 视为用户侧输入（否则只能采到助手侧、配不成一轮）。
- **诊断日志**（v1.1.1 起默认开启，只记原因不记内容）：
  - `collect-skip`：`seq-already-processed` / `not-user-authored`（带 `sourceKind` 与 `length`）/ `looks-synthetic` / 
    `text-too-short-or-empty` / `no-pending-user` / `assistant-text-empty` / `invalid-seq`，每 session+原因前 3 条 + 每 200 条汇总；
  - `collect-filtered`：被会话过滤规则跳过（subagent / exclude 正则等），每 session 前 3 条 + 每 200 条汇总；
  - `/brain memory` 末尾会打印「采集诊断：已采 N，跳过 …，过滤 …」。
- **可恢复配对**（v1.1.1）：`user/message` 一到达就写入 `collector_pending` 并推进水位，
  即使助手回复延迟、插件重载或 DSH 重启，下一轮助手消息仍会与它配对成一轮；配对成功后清除 pending。
- **幂等**：每个会话记录最后处理的 `event.seq`（持久化在各层数据文件 `lastSeq`），
  同一事件重复投递只记一次。
- **不阻塞**：监听回调同步 try/catch；记账后的 LLM 任务放到脱离的 Promise，
  失败只写 `brain.log`（`fact-llm-failed` / `summary-failed` …）。

## 后台消化（v1.2.0：把表意识压入长期记忆，无损）

用户对「上下文整理」的定义是**记忆分流**，不是压缩：

> 后台静默把脑海中的记忆压入长期记忆（潜意识），需要时再从长期记忆把相关记忆捞到
> 工作记忆（表意识能读到）。记忆层就是那个长期记忆。

`src/consolidator.js` 负责前半段，硬约束：

- **只读会话**：只监听 `session/event`、只读 `memory_turns`；不写任何会话事件、不改 surface、
  不调 `compaction`、不产生用户可见输出。单测里通过「包装 `ctx.emit` 后计数为 0」验证。
- **原文永不删**：整理只把处理过的轮次标记 `consolidated = 1`；`memory_turns` 的
  user/assistant 全文、sessionId、seq、时间、mood 原样保留，`/brain memory <关键词>` 与
  `fetchTurn`/`fetchRange` 随时可精确取回。**没有把一整轮压成一句摘要导致失忆的路径。**
- **触发**（二选一）：
  - `session/event` 的 `turn/end` 累计到 `consolidateEveryTurns`（默认 4）轮；
  - `turn/end` 后等 `idleConsolidateMs`（默认 90000ms）空闲补一次；期间出现 `turn/start`
    或 `user/message` 就取消重排。
- **互斥与静默**：同一会话 running 时直接跳过；任何异常（记忆层缺失、DB、LLM、字段缺失）
  只写 `consolidate-failed` / `consolidate-skip` 日志，绝不冒泡。
- **产物**：
  1. **事实**：复用规则抽取（`extractUserFacts` / `extractSelfFacts`），`consolidateMode: 'llm'`
     时再叠一次 LLM 补充；
  2. **情节记忆** `memory_episodes`：第三人称小摘要（≤160 字）+ 原文 `turn_ids` 指针 +
     当时情绪快照 + `salience` + 检索 `terms`；
  3. **滚动摘要**：把这段的小摘要并进 user/self 两侧（`appendSummary`，去重、保尾部）。
- **salience 规则**（0.05–0.95，可解释）：基础 0.3；命中个人信息 +0.2；承诺 +0.12；
  强情绪 +0.12；同一检索项在 ≥2 轮出现 +0.08；用户侧总字数 ≥60 +0.05。
- **模式**：`rule`（默认，零模型调用）/ `llm`（一次模型调用产出事实补充 + 摘要；失败
  自动回退规则）/ `off`（不消化）。

## 工作记忆召回（v1.2.0：把相关记忆捞到上下文）

`src/context.js` 每次组装 prompt 时现算；同样**不写任何会话内容**。

- 注册位置：`ctx.systemPrompt.section({ name: 'dsh-brain:context', order: 100, text: () => … })`
  —— 100 落在 persona 前缀（0）与 plan policy（500）之间，属于「人格/背景」区域；
  文本 provider 每次组装 prompt 时现算（只读状态，不读文件），**任何异常返回 `''`**。

- **检索词**：本轮用户输入 + 最近 1–2 轮用户输入（来自只读的 `session/event user/message`
  跟踪；拿不到时回退 `memory_turns` 最近一轮，5 分钟内有效）。
- **候选**：相关事实（`factsForPrompt`）、相关情节（`recallEpisodes`）、旧对话原文
  （`recall` 兜底）、双侧摘要、当前情绪、人格倾向。
- **情节打分**：`相关度 0.55（query 二元组命中 terms/摘要）+ salience 0.30 + 新近度 0.15
  （14 天半衰期）`；相关度为 0 的不召回。`mood.self.affection ≥ 0.6` 时，命中
  `答应/约好/陪/一起/喜欢/谢谢/信任/承诺` 的关系类情节 +0.08。
- **去重冷却**：同一记忆 3 轮内不重复注入；本轮再次提到它的检索词时允许刷新
  （`recallCooldownTurns` 可配）。
- **预算**：`workingMemoryMaxChars`（默认 1200）按人格/情绪微调
  （`detail` 高 +最多 45%，`directness` 高 -最多 15%，`affection ≥ 0.6` 关系类 +10%）；
  全局 `maxChars`（默认 1800）再夹一次。裁剪优先级：**画像事实 > 相关记忆 > 摘要 > 情绪/人格**。
- **输出结构**：

  ```
  【工作记忆 · 相关回忆】（只在你自然用得上的时候提，不要复述）
  - 你们之前聊到：用户和助手聊到：…（episode 摘要）
  - 你以前说过（11-21）：…（原文片段，附来源时间）

  【关于你（用户）】
  - 名字：小林
  - 用户在准备季度报告
  - 此刻状态：有点累，心情平稳

  【关于我（这个助手）】
  - 你倾向先解释再给结论
  - 当前状态：专注，精力一般，和用户相处自然

  （以上只是背景，不必主动复述，也不要报出具体数值。）
  ```

- **来源元数据**：`stats.workingMemory.sources` 记录每条注入记忆的 `id / kind / at /
  sessionId / seq / turnIds / snippet`（prompt 里只放短时间标签，不塞 id）；需要原文时用
  `fetchTurn(id)` / `fetchRange(sessionId, from, to)` 取回。
- 不暴露内部结构：不出现 `valence`/`affection`/`system prompt` 等字样，也不输出数值；
  `enabled: false` 时不注册（服务仍提供，供 `/brain` 观察与其它插件调用）。

## v2.0.0：全存 / 归档 / 话题召回

### 全存
`memory_turns` 保存 user/assistant 完整原文（`maxTextChars` 默认 20000/条，可到 200000）；
`fetchTurn(fetchRange/searchTurns)` 精确取回。归档前必须逐条读回校验，失败就不替换 surface。

### 归档（`src/archiver.js`）
- 选择：`session.surface.nodes` 按完整 turn 分组，保留最近 `keepRecentTurns` 轮+当前轮，
  取最旧 `archiveMaxTurnsPerBatch` 轮；起止切点必须 tool 配对平衡（复刻 DSH 折叠规则），
  node 0 system prompt 不参与；`tokenMeter.contextPressure > archiveAtPercent` 才触发。
- 执行：先 `rememberTurn` 落库并 `fetchTurn` 校验 → `session.append('user/message', marker,
  { surfaceOp:{op:'replace', startSeq, endSeq}, sourceEventSeqs:[...shadowed] })`；marker
  `source.kind='brain-archive'`，文案 `[已归档到记忆库：N 轮 · MM-DD HH:mm–HH:mm · 可检索]`。
- 时机：`turn/end` 后延迟到事件发布结束（否则 DSH 报 `append cannot reenter`）；同会话互斥。
- 记录：`memory_archives` + `memory_turns.archived/archive_id`；异常只写 `archive-failed`。
- 默认：`archiveEnabled:false`、`archiveDryRun:true`；scratch 会话已验证通过（见报告）。

### 话题召回（`recallOriginals`）
打分 = 相关度 0.55（bigram+IDF）+ 话题连续性 0.20 + 时间衰减 0.15 + 归档加成 0.12；
最近 1–2 轮判断话题，与话题零重叠的归档段不注入（通用词除外），用户点名关键词强加权；
注入 `你以前说过（11-21 14:30，turn #12）："…原文片段≤120字…"`，每轮 ≤`recallLimit`、
预算 `recallMaxChars`、3 轮冷却。模板化噪声（`Time sampled while…` 等）采集与召回都跳过。

## `/brain` 命令

| 输入 | 输出 |
|---|---|
| `/brain` | 四层总览：轮数/事实数/摘要字数 + 长期记忆（事实/情节/摘要 · 上次整理 · 本轮注入）+ 两侧情绪、人格、注入状态 |
| `/brain memory` | 每侧前 8 条事实 + 摘要 + 长期记忆（已整理/待整理轮次、情节列表）+ 本轮工作记忆 + 采集诊断 |
| `/brain memory <关键词>` | 按关键词列出**原文**（用户/助手截断展示 + 日期/sessionId/seq/id），供人工核查 |
| `/brain recall <关键词>` | 召回调试：每条候选的 score（相关/话题）、是否已归档、原文片段 |
| `/brain mood` | 用户与助手两侧状态 + 最近轨迹 |
| `/brain persona` | 两侧倾向的自然语言渲染 |
| `/brain profile` | 域角色层（规范）：摘要 + **实际注入的原文**（v2.2.0） |
| `/brain who` | 角色层（"我是谁"）：当前定义 + 版本 + 证据轮数 + 最近版本（v2.2.0） |
| `/brain who revise` | 立刻让模型按对话重写一版角色定义（未定义时是 bootstrap） |
| `/brain who name <名字>` | 改角色名（不产生新版本） |
| `/brain patient` | 实体层：列出已知对象（类型 + 聊过几轮）（v2.3.0） |
| `/brain patient <名字>` | 这个对象的档案：带时间要点 + 最近聊到的原文片段 |
| `/brain consolidate` | 立即对当前会话跑一次后台整理（不调 compaction、不改原文；失败给中文原因） |
| `/brain reset confirm` | 重置三层（各自先备份 `*.bak-<ts>`）；缺 `confirm` 会拒绝 |

除 `/brain consolidate` 会触发一次只读整理外，命令只读本地状态；不把内容发给模型。

## 配置（每层独立，bundle patch 给默认值；用户可按行 id 覆盖，config 整段替换）

### dsh-memory

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` / `dbFile` | `''` / `''` | 数据目录 / SQLite 文件（空=`<dataDir>/brain.db`） |
| `enabled` | `true` | 本层采集开关 |
| `maxTurns` | `60` | 原文轮次上限 |
| `summaryEnabled` / `summaryThreshold` | `true` / `24` | 滚动摘要开关与触发轮数 |
| `factExtractInterval` | `3` | 每几轮做一次事实抽取 |
| `factExtractMode` | `rule` | `rule` / `llm` / `off` |
| `maxFactsPerSide` / `maxFactChars` | `80` / `60` | 每侧事实上限 / 单条长度 |
| `writeMarkdown` | `true` | 是否写 `brain.md` |
| `collectSubagents` | `false` | 是否采集子代理会话（开启后子会话里的 agent-message 也视为用户侧输入） |
| `excludeSessionIdPattern` | `pet` | 跳过匹配的会话（id 或 cwd） |
| `includeSessions` | `[]` | 只采集匹配会话（空=全采集） |
| `maxTextChars` / `minTextChars` | `2000` / `2` | 截断 / 最短采集长度 |

### dsh-mood

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` / `dbFile` | `''` / `''` | 同上（四层共享同一个 DB 文件） |
| `enabled` | `true` | 本层开关 |
| `moodDecayMinutes` | `120` | 超过多少分钟开始时间衰减 |
| `historyLimit` | `30` | 每侧轨迹上限 |
| `deepNightEnergyPenalty` / `deepNightValencePenalty` | `0.05` / `0.02` | 深夜额外扣减 |
| 采集键 | 同 memory | `collectSubagents` / `excludeSessionIdPattern` / `includeSessions` / `maxTextChars` / `minTextChars` |

### dsh-persona

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` / `dbFile` | `''` / `''` | 同上 |
| `enabled` / `dynamicsEnabled` | `true` / `true` | 采集 / 动态倾向 |
| `baselineUser` | `{directness:.5, pace:.5, humor:.4, detail:.5}` | 用户侧基线 |
| `baselineSelf` | `{warmth:.6, directness:.55, playfulness:.4, proactivity:.5}` | 助手侧基线 |
| `regressionPerDaySelf` / `regressionPerDayUser` | `0.3` / `0.12` | 每天回归比例（用户侧更慢） |
| 采集键 | 同 memory | 同上 |

### dsh-context

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` / `enabled` | `''` / `true` | 目录 / 是否注册注入段 |
| `userName` / `agentName` | `用户` / `助手` | 文案称呼 |
| `maxChars` | `1800` | 注入文本总长上限 |
| `workingMemoryMaxChars` | `1200` | 工作记忆（相关回忆）字符预算 |
| `factLimit` | `6` | 每侧最多注入几条事实 |
| `recallLimit` / `turnRecallLimit` | `3` / `2` | 最多注入几条相关情节 / 情节不够时补几条旧对话原文 |
| `recallCooldownTurns` | `3` | 同一记忆多少轮内不重复注入（被再次提到会刷新） |
| `includeUser` / `includeSelf` | `true` / `true` | 是否注入某一侧 |
| `sectionOrder` | `100` | system prompt 排序位置 |
| `commandEnabled` | `true` | 是否注册 `/brain` |
| `debugSection` | `false` | 诊断：每次 `sectionText()` 被调用时写 `section-text` 日志（长度/段数/三层是否取到/注入条数） |
| `consolidateEnabled` | `true` | 是否启用后台消化 |
| `consolidateEveryTurns` | `4` | 累计多少轮 `turn/end` 触发一次 |
| `idleConsolidateMs` | `90000` | 空闲多久补一次（0=关闭空闲触发） |
| `consolidateMode` | `rule` | `rule` / `llm` / `off` |
| `consolidateMaxTurns` / `consolidateMinTurns` | `12` / `1` | 单次最多消化多少轮 / 少于多少轮先不消化 |
| `consolidateEpisodeMaxChars` / `summaryAppendMaxChars` | `160` / `600` | 情节摘要上限 / 每侧滚动摘要上限 |
| `debugConsolidate` | `false` | 诊断：每次消化打 `consolidate-debug` 日志 |
| `recallMaxChars` / `recallLimit` / `turnRecallLimit` | `1200` / `4` / `3` | 召回预算 / 每轮最多几条 / 最多补几条旧原文 |
| `topicShiftEnabled` / `recallTopicTurns` | `true` / `2` | 话题连续性过滤 / 用最近几轮判断话题 |
| `archiveEnabled` / `archiveDryRun` | `false` / `true` | 归档开关 / 只演练不 append（双保险） |
| `archiveAtPercent` / `keepRecentTurns` / `archiveMaxTurnsPerBatch` | `0.5` / `4` / `8` | 压力阈值 / 保留最近轮数 / 单次最多归档轮数 |
| `archiveMarker` / `archiveSessionIds` | `oneline` / `[]` | 标记文案 / 白名单（测试用） |
| `roleEnabled` | `false` | 是否注册**域角色段**（v2.2.0） |
| `roleSectionOrder` | `90` | 域角色段的排序位置（比 `sectionOrder` 小 = 更靠前，静态前缀更稳） |
| `role` | 空角色 | 域角色内容，见下 |
| `characterEnabled` | `true` | 是否注入**角色段**（模型写出的自我定义，v2.2.0） |
| `characterSectionOrder` | `95` | 角色段排序位置（规范 90 → 角色 95 → 上下文 100） |
| `characterMaxChars` | `600` | 角色定义注入上限 |
| `characterReviseEveryTurns` | `6` | 攒够多少轮新证据才让模型修订一次角色定义 |
| `entityEnabled` | `true` | 实体层（v2.3.0）：后台抽取 + 注入「当前对象」段 |
| `entityLimit` | `2` | 一轮最多注入几个对象的档案 |
| `entityMaxChars` | `400` | 「当前对象」段字符上限 |
| `entityFactLimit` / `entityTurnLimit` | `6` / `3` | 每个对象注入几条要点 / 几条"最近聊到" |
| `entitySpreadEnabled` | `true` | 激活扩散：列出与当前对象同段出现过的其他对象 |
| `entityFocusTtlMinutes` | `30` | 表意识槽位 TTL：隔这么久再提「他」不再接旧对象 |
| `entityExtractMode` | `rule` | 睡眠期结构化巩固：`rule`=只存原话片段 / `llm`=抽主诉·辨证·处方等字段 / `off`=关闭 |

#### `role`（v2.2.0 域角色层）

| 键 | 说明 |
|---|---|
| `domain` / `title` | 域与角色名（`title` 为空时用「<domain>协作助手」） |
| `identity` | 一段"你是谁"的定位（≤400 字） |
| `sharedMemoryNote` | 是否输出「所有会话共享同一份记忆、不要把不同对象记录互相套用」（多患者场景建议开，默认 `true`） |
| `expertise` / `habits` / `preferences` | 用户画像：擅长 / 习惯 / 偏好（各 ≤6 条） |
| `rules` | 专业规范（≤12 条） |
| `redlines` | 红线（≤12 条）：违反就不要给答案。**注入预算不够时也不丢** |
| `referrals` | 必须转人工 / 线下确认的情形（≤8 条）；标题是通用的，不写行业专用词 |
| `uncertainty` | 不确定时的策略（≤4 条；为空时给默认"先问、给依据、不编造"） |

注入顺序（两段）：`dsh-brain:role`（静态，order 90）→ `dsh-brain:context`（动态，order 100）。
`/brain profile` 打印的就是前一端的**原文**。

## 存储：SQLite（v1.1.0 起）

四层共享一个数据库文件 `%USERPROFILE%\.dsh\dsh-brain\brain.db`（每层可用 `dbFile` 覆盖，
四层必须指向同一个文件才共享数据；`dataDir` 仍决定默认位置与 `brain.md`/`brain.log` 目录）。

实现见 `src/db.js`：
- 模块级单例：同一进程内按 `dbFile` 路径共享一个 `DatabaseSync` 连接，引用计数管理，
  最后一个使用者卸载时 `close()`；
- 打开时设 `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`；
- `meta` 表记录 `schema_version`（同时写 `PRAGMA user_version`），`CREATE TABLE IF NOT EXISTS`
  幂等，可重复加载；
- 预处理语句缓存；写操作用事务（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，
  嵌套调用并入外层事务）。

### 表结构

| 表 | 作用 |
|---|---|
| `meta(key, value)` | schema 版本、创建时间、主人名、抽取/摘要水位线、上次整理时间、persona 更新时间等 |
| `memory_turns(id, session_id, seq, at, user_text, assistant_text, mood, provider, model, consolidated, turn, archived, archive_id)` | 原文轮次（**无损**）；`consolidated`=已后台消化，`turn`=会话内 turn 号，`archived/archive_id`=已从 surface 换出 |
| `memory_archives(id, session_id, at, start_seq, end_seq, turn_count, tokens_before, tokens_after, marker_seq, marker_message_id, turn_ids, status, created_at)` | 归档记录（v2.0.0）：哪段 surface 被换成标记、原文 turn_ids |
| `memory_facts(id, side, text, norm, kind, weight, hits, created_at, last_seen_at)` | 双向事实；`UNIQUE(side, norm)` 兜底去重 |
| `memory_episodes(id, session_id, at, summary, turn_ids, mood, salience, terms, created_at)` | 情节记忆（v1.2.0）：摘要 + 原文指针 + 情绪 + 重要度 + 检索项 |
| `memory_summaries(side, summary, chars, updated_at)` | 双向滚动摘要 |
| `mood_state(side, name, status, valence, affection, energy, updated_at)` | 双向情绪当前状态 |
| `mood_history(id, side, at, name, valence, affection, energy, reason)` | 心情轨迹（每侧保留 `historyLimit` 条） |
| `persona_traits(side, trait, value, updated_at)` | 双向人格倾向 |
| `persona_baseline(side, trait, value)` | 双向基线（`/brain reset` 后重置为配置基线） |
| `collector_state(session_id, layer, last_seq, updated_at)` | 每层每会话的采集水位线；`PRIMARY KEY(session_id, layer)` |
| `collector_pending(session_id, layer, user_text, seq, at)` | 等待助手回复的「用户消息」（v1.1.1 起）；插件重载/DSH 重启后仍可配对，不丢人类消息 |
| `characters(id, name, emoji, definition, evidence_turns, last_evidence_seq, version, source, updated_at, created_at)` | 角色（v2.2.0）：模型从对话写出的「我是谁」；`version`=0 表示还没 bootstrap |
| `character_versions(character_id, version, definition, reason, evidence_turns, created_at)` | 角色定义历史（只增不改）：每一版是谁、因为什么（bootstrap / revise） |
| `entities(id, kind, name, aliases, attrs, source, created_at, updated_at)` | 实体（v2.2.0 建表，v2.3.0 接逻辑）：患者/客户/项目…跨会话对象档案 |
| `entity_facts(id, entity_id, kind, text, at, turn_id, session_id, created_at)` | 实体事实：挂到具体对象上的带时间要点 |
| `entity_turns(entity_id, turn_id, at, session_id)` | 实体 ↔ 轮次：对象最近聊过什么、原文溯源 |
| `wm_state(session_id, kind, data, updated_at)` | 表意识槽位（v2.3.0）：「眼下在说谁」的实体 id + 时间，带 TTL |

索引：`memory_turns(at)`、`memory_turns(session_id)`、`memory_facts(side, kind, weight)`、
`memory_episodes(at DESC)`、`memory_episodes(session_id)`、`memory_episodes(salience DESC)`、
`mood_history(side, at DESC)`、`collector_state(updated_at)`、
`character_versions(created_at DESC)`、`entities(kind, name)`、
`entity_facts(entity_id, at DESC)`、`entity_turns(entity_id, at DESC)`。

schema 版本：v1.0.0→1（JSON 迁移）、v1.1.0→2（SQLite）、**v1.2.0→3**（`memory_episodes` 表 +
`memory_turns.consolidated` 列）。升级是幂等的：`CREATE TABLE IF NOT EXISTS` + `PRAGMA
table_info` 检查后 `ALTER TABLE ADD COLUMN`，旧库自动补齐。

> 与参考交付包（`fakeseek-v28-交付包`，App 侧 IndexedDB 的 sessions / sessionSummaries /
> files / staging 多表）对应关系：`memory_turns` ↔ sessions、`memory_summaries` ↔
> sessionSummaries、`memory_facts` ↔ 记忆条目表、`collector_state` ↔ 增量水位表；
> 桌面端没有文件/暂存需求，故未建 files / staging 表。

### 迁移（v1.0.0 JSON → SQLite）

首次打开 DB 时，若同目录存在旧的 `memory.json` / `mood.json` / `persona.json` / `state.json`，
在一个事务里**幂等导入**（轮次按 id、事实按 `(side,norm)`、摘要/情绪/倾向按主键去重，
历史轨迹仅在目标侧为空时导入），成功后把文件改名为 `*.imported-<ts>`，日志
`db-migrated`。再次放入同样的 JSON 重新打开也不会重复导入（已验证）。

### 轮次裁剪（唯一会让原文离库的机制）与「不做压缩」

**边界要说准**（v2.0.0 起）：编辑器会改「当前上下文」，但**不改写原文**。

- **原文**：`memory_turns` 永久保存（`maxTurns` 是有界环形，默认 60，可调大）；
  归档也不会删它，只是把旧轮次从**会话 surface** 上换成一行标记。
- **当前上下文（工作记忆）**：会被编辑 —— 召回往里加、归档往外搬。归档默认关闭
  （`archiveEnabled: false` + `archiveDryRun: true`），要显式打开才生效。
- **不调 DSH 的 `compaction`**，也不写自己的「压缩摘要」去替代原文；episode 只是
  **索引 + 小摘要**。

`memory_turns` 满了之后（超过 `maxTurns`）才会删最旧的若干行：删除前，事实/情节/摘要
已经由后台消化写进长期记忆；此时 episode 的 `turn_ids` 指向已裁剪原文、
`fetchTurn(id)` 返回 undefined 是预期行为。不做强制 `VACUUM`；`/brain reset confirm`
会在重置前用 `VACUUM INTO` 生成 `brain.db.bak-<ts>` 备份。

如果要求「一句都不许丢」，把 `maxTurns` 调大（例如 500）即可；本包不引入任何
「压缩成一句话」的路径。

### 为什么不用 `storageDomain`

DSH 的 `storageDomain` 要求用 Zod/schemastery 声明数据域 schema；本包是零依赖的本地
link 安装，解析不到 `zod` / `@deepseek-ai/schemastery`。`node:sqlite` 是 Node 内置模块
（Node 24 自带；DSH 自己的 `dsh-session-query-sqlite` 也走它），所以选 SQLite 文件 +
手工 DDL，保持零依赖。

## 核查工具 `tools/brain-db.mjs`

用 DSH 自带 node 跑（只读打开，不会改库）：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
& $node tools\brain-db.mjs stats              # schema 版本 / 各表行数 / DB 大小
& $node tools\brain-db.mjs turns 5            # 最近 5 轮真实采集
& $node tools\brain-db.mjs facts user         # 一侧事实
& $node tools\brain-db.mjs mood self          # 情绪状态 + 轨迹
& $node tools\brain-db.mjs persona            # 倾向 + 基线
& $node tools\brain-db.mjs sql "SELECT ..."   # 只读查询（非 SELECT 会被拒绝）
& $node tools\brain-db.mjs --db <路径> stats  # 指定其它 DB
```


## 隐私与影响面（重要）

- **采集范围**：默认只采集普通人类会话，跳过 subagent 子会话；可配 `includeSessions` /
  `excludeSessionIdPattern` 精确圈定。采集的是消息的纯文本（不含图片/工具参数），
  超长截断。敏感内容仍可能被记入 `brain.db`（`memory_turns` / `memory_facts` 表），
  需要时可用 `/brain memory` 查看、`/brain reset confirm` 清空，或直接关闭对应层。
- **注入影响面**：注册的是**全局** system prompt section（`AssembleContext` 只提供
  `scope`/`signal`，拿不到 session id），因此所有会话——包括 subagent 会话——都会看到
  这段背景。它只增加约 200–1500 字符、位置在人格区（order 100），不会改动工具列表、
  不会覆盖其它 section；`enabled: false` 可整体关闭。
- **不干扰主链路**：采集是只读事件监听，失败被 try/catch 与脱离 Promise 隔离；
  注入文本 provider 不读盘、不调模型，异常返回 `''`。
- **不新增网络**：不监听端口、不外部请求；唯一的外部调用是记忆层低频摘要/事实补充时
  走 DSH 自己的 `ctx.llm`（可用 `factExtractMode: rule`、`summaryEnabled: false` 完全关掉）。

## 已知限制

- 事实抽取是中文启发式规则（问句、合成消息、表白式语句会被跳过）；冷门说法可能漏抽，
  `factExtractMode: 'llm'` 可补，但会多花 token。
- 「相关记忆」的相关度用字符 bigram，中文短句效果好，跨语言/长文一般。
- 注入是全局的、无法按会话区分（见上）；也不区分「哪个 agent 在跑」。
- 零依赖，因此不导出 schemastery `Config`（每层在 `apply` 里手工 normalize）；
  Plugin Manager 的 Config 表单无 schema，但 YAML patch 完全可用。
- 采集到「配对」依赖 user/message 与 assistant/message 的事件顺序；若某个回合只有助手
  消息（例如人工注入），该条不记一轮。
- SQLite 用内置 `node:sqlite`（Node 24 / Electron 44 自带，DSH 的 session-query-sqlite
  也用它）。如果未来 DSH 运行时去掉该模块，插件会加载失败并写 `init-failed` 日志；
  届时可回退到 JSON 存储（本包 v1.0.0 的实现仍在 git/备份中）。
- 四层共享一个 DB 文件：必须让 memory/mood/persona 的 `dbFile` 指向同一路径
  （默认都是 `<dataDir>/brain.db`）；只改其中一层会让它读写到另一个库。
- `/brain reset confirm` 会为每层各生成一份 `brain.db.bak-<ts>`（三层各一次
  `VACUUM INTO`），属于重复备份但保证任何一层重置都不丢整体数据。

## 卸载 / 回滚

```powershell
plugin_manager remove_bundle target=@shenyue/dsh-brain   # 4 行消失、注入停止
# 数据保留在 ~\.dsh\dsh-brain\brain.db：想彻底重置就删掉 brain.db（及 -wal/-shm）
# 旧 pet-bridge 数据目录不受影响
```


