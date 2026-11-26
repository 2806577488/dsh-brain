# @shenyue/dsh-brain

把「AI 助手的大脑」做成 4 个 **DSH 原生 Host 插件**，按人的记忆分层来搭：

- 前三层是**长期记忆面（潜意识）**：`dsh-memory` 存原文/事实/情节，`dsh-mood` 存情绪，
  `dsh-persona` 存双向倾向；
- 第四层 `dsh-context` 是**工作记忆面（表意识）**：「当前这一轮模型看到什么」就是它决定的 ——
  既**往回捞**（把相关原文/事实召回进上下文），也**往外搬**（归档旧轮次，用一行标记替换；
  原文永久留在 `memory_turns`）。

不接桌宠、不监听任何端口、不发任何外部请求。**原文永不改写**；会被编辑的只有「当前上下文」
（归档开关默认关闭）。

| 插件行 | 层 | Service | 作用 |
|---|---|---|---|
| `dsh-memory` | 记忆层（长期记忆） | `brainMemory` | 双向长期记忆：`user` 侧（关于用户/「你」）+ `self` 侧（关于助手自己/「我」）；原文 + 事实 + 情节索引 + 摘要 |
| `dsh-mood` | 情绪层 | `brainMood` | 双向情绪：用户的 valence/energy、助手自己的 valence/energy/affection/status |
| `dsh-persona` | 人格收集层 | `brainPersona` | 双向倾向：用户沟通风格 + 助手表达倾向，随对话演化并回归基线 |
| `dsh-context` | **工作记忆层（当前上下文）** | `brainContext` | 编辑这一轮的上下文：召回（加）+ 归档（减，默认关）+ `/brain` 命令 |

## v2.3.0：实体层（患者 / 客户 / 项目 —— 跨会话的对象档案）

起因：记忆层是「关于用户」「关于我」两条平铺的线，真实工作里的对象是**分开的**——
张三的主诉、李四的处方、某个项目的进展混在一条事实流里，取回时只能靠字面相似度碰运气；
换个会话就接不上"上次说的那个患者"。

- **表（schema 6）**：`entities`（名字/别名/类型）、`entity_turns`（这个对象聊过哪几轮，
  可溯源到原文）、`entity_facts`（挂在对象上的带时间要点）。
- **规则抽取（`src/entities.js`），宁缺毋滥**：只认明确信号——
  `患者张三` / `病人：李姐` / `客户王先生` / `张三先生` / `项目留声` / `宠物豆豆`。
  中文没有分隔符，所以 2 字优先（`患者张三主诉咳嗽` 取 3 字会变成「张三主」），
  复姓与「姓+多字敬称」例外；抽不出来就**不建档案**，绝不编。
- **两类关联都挂**：本轮新出现的对象 + 本轮只提到名字的既有对象（"接着上次说"）。
- **实体优先注入**：本轮提到的对象档案放在注入文本**最前面**（`【当前对象 · 张三（患者）】`
  + 带时间要点 + 最近聊到），预算不够时先保它。
- **表意识槽位（v2.3.0）**：每个会话记一份"眼下在说谁"（实体 id + 时间，TTL 默认 30 分钟）。
  下一句只说「他今天怎么样」也能接上上一个患者；隔太久就失效，不硬接。
- **激活扩散（v2.3.0）**：跟当前对象**在同一段对话里出现过**的其他对象，作为
  `【相关对象】` 一并给出（例如"和患者李四在同一段对话里出现过"）。
- **睡眠期结构化巩固（v2.3.0）**：规则抽取只存"原话片段"；把 `entityExtractMode` 设成
  `llm` 后，后台整理会再调一次低频模型，把对话压成**主诉 / 症状 / 辨证 / 治法 / 处方 /
  医嘱 / 复诊 / 检查 / 过敏** 这些字段写进档案（只接受已知对象、同文本去重、失败静默）。
- **命令**：`/brain patient`（列已知对象）· `/brain patient 张三`（档案 + 最近轮次）。
- **后台抽取**：后台整理（睡眠期）时顺带跑，纯 DB、同步、失败不影响整理。

> 现在的分工：**规范**说"该怎么答"，**角色**说"我是谁"，**实体**说"这次在说谁"，
> **记忆**负责把相关原文捞回来。

## v2.2.0：规范（静态）+ 角色（对话塑造的自我定义）

起因：v2.1.0 之前这个"大脑"只有双向记忆 + 情绪 + 人格数值。它能记住「用户喜欢直接」，
但**缺两类东西**，而它们是两件不同的事：

- **规范**：这个领域专业上必须守什么。人工写、不随对话变 —— 安全底线不能靠模型发挥；
- **角色**：「我是谁」。**这是由对话塑造的**，不是写定的。角色诞生时模型就该参与界定，
  之后随对话演化。

以前把这两件事混成"角色卡"（写死的人设），于是要么假、要么空。

### 规范层（`src/role.js`，静态，order 90）

- 只认通用字段：`domain / title / identity / expertise / habits / preferences /
  rules / redlines / referrals / uncertainty`，**插件不认识任何具体行业**；
- 结构：`【角色】` → `【用户画像】擅长·习惯·偏好` → `【专业规范】` → `【红线】` →
  `【必须转人工 / 线下确认】` → `【不确定时】`；
- 预算不够时按「不确定策略 > 偏好 > 习惯 > 擅长」丢条目，**专业规范与红线永不丢**；
- 默认关闭（`roleEnabled: false`）；配方示例：`examples/profiles/tcm.yml`（中医临床）、
  `examples/profiles/code-review.yml`（代码评审），校验 `node tools/render-profile.mjs <file>`。

### 角色层（`src/character.js`，动态，order 95）

- **bootstrap**：角色还是 v0、且攒够第一批证据（后台第一次整理）→ 让模型根据对话写第一版
  「我是谁」；
- **revise**：之后每攒够 `characterReviseEveryTurns`（默认 6）轮，带「当前定义 + 新证据」
  让模型改写；沿用仍然成立的部分，不因一次偶发对话改性格；
- **版本历史**：`character_versions` 只增不改，`/brain who` 能看每一版与原因；
- **降级**：模型不可用时**不编造**，用规则兜底（只写"我们聊过这些"的事实）并标
  `source: fallback`，下次修订覆盖；
- **注入**：`dsh-brain:self` 段，在静态规范之后、动态上下文之前 —— 它变化很慢，
  放前面能让 system prompt 前缀更稳定（缓存友好）。
- 命令：`/brain who`（看定义/版本）、`/brain who revise`（立刻重写）、
  `/brain who name <名字>`（改名，不产生新版本）。

> 三段的定位：**规范说"该怎么答"，角色说"我是谁"，记忆说"关于谁、答什么"**。
> 实体（患者/客户/项目）档案与实体优先召回是 v2.3.0 的事（schema 6 已建好
> `entities` / `entity_facts` / `entity_turns`，逻辑待接）。

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

