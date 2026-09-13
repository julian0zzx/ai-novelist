# 存储层改造方案：`novel.json` 元数据 + 内容 Markdown 文件

> 状态：**已确认设计，待实现**。
> 决定来源：用户 2026-09 的三项选择 —— ① 采用本文件 §2 的文件树；② 冲突策略为
> **"以文件为准，自动采纳"**；③ 实现前先重开会话（工作区改为本仓库新路径）。
>
> 实现者请注意：本文件是这次改造的契约。§3 的 frontmatter 键名、§4 的归属表、
> §6 的写入顺序都已拍定，不要各自发挥；有异议先改本文件再加代码。

---

## 1. 目标与代价

**目标**：`.novel/novel.json` 退化为元数据仓库；小说内容（全书大纲、人物设定、世界观
设定、分卷大纲、章节大纲、章节细纲、章节正文）各自成为工作区里的独立 Markdown 文件，
人可以直接阅读、直接用编辑器修改。

**接受的代价**（用户已明确选择）：

1. **多文件没有单一事务**。现在的"一个 JSON 文档 + 一次 `replaceIfVersion` 原子写"变成
   多个文件的多步写入。缓解见 §6：内容文件先写、元数据后写，失败时报告"哪些文件已写、
   哪些没写"，绝不谎报成功。
2. **以文件为准，自动采纳**（用户选择）。人（或其它工具）改了 Markdown，即视为权威输入，
   工具读取时采纳并把索引刷新到 `novel.json`。
   **唯一的护栏**：文件**语法坏掉**时不算"采纳"，而是**报错并指名文件与原因**，
   绝不静默丢弃内容、也绝不用内存里的旧值覆盖它。采纳针对的是"能解析的文件"，
   不是"任何文件"。
3. **多一处分层**：`core/*` 的纯函数不变，但它们操作的 `NovelState` 由 store 从
   "元数据 + 一组 Markdown 文件"组装出来。组装/拆解逻辑集中在 store 与 codec。

---

## 2. 文件树（已确认）

```
<workspace 根>/
├── .novel/
│   ├── novel.json                    # 元数据 + 索引（§4）
│   └── reviews/review-<n>-<kind>.md  # 模型评审记录（现状不变）
├── 全书大纲.md
├── 人物设定.md
├── 世界观设定.md
├── 分卷大纲.md
├── 章节大纲.md
└── 章节/
    ├── 第001章-山门.细纲.md          # 契约（六字段）
    └── 第001章-山门.md               # 正文
```

### 2.1 命名规则

- 顶层五个文件名**固定中文名**，不随书名变化。
- 章节文件：`第{章号补零到 3 位}章-{净化后的标题}.md`；标题为空时 `第001章.md`。
  细纲文件在同名后加 `.细纲`，即 `第001章-山门.细纲.md`。
- 标题净化：去掉 `/ \ : * ? " < > |`、控制字符、首尾空白与点号；截断到 40 字。
- **稳定键是 `id`（slug），不是文件名**。`id` 写在 frontmatter 里，所以改标题导致的
  文件改名可以恢复：索引按 `id` 定位，读目录时按 frontmatter 的 `id` 认领文件。
- 章号或标题变化时，工具负责 `rename` 文件并更新索引；`章节大纲.md` 同步刷新。

### 2.2 章节文件规模说明

1000 章 = 2000 个章节文件。若日后觉得 `章节大纲.md` 单文件过大（它随章节数线性增长，
且每次计划变更都要整份重写），可改为按卷拆分 `章节大纲/第1卷.md`。**本次不做**，
但读取代码不要假设"章节大纲只有一个文件"——用索引里的路径列表驱动。

---

## 3. 文件格式

统一形态：**YAML frontmatter（机器读）+ Markdown 正文（人读）**。解析器只依赖
"frontmatter + `##` 小节 + ```yaml 块 + 表格"这四样，不做自由文本推断。

### 3.1 `全书大纲.md`

```markdown
---
fullOutlineDone: false
updatedAt: 2026-09-13T14:20:34.921Z
---

# 全书大纲

## 一句话

（logline）

## 三幕

1. （第一幕）
2. （第二幕）
3. （第三幕）

## 最小可行大纲

（minimal）
```

解析：`## 一句话` / `## 最小可行大纲` 取其后正文；`## 三幕` 取有序列表项（保持顺序，
允许 1 项以上，不强制恰好 3 项——SOP 说三幕，但工具不因此拒绝）。

### 3.2 `人物设定.md` / `3.3 世界观设定.md`

一个条目 = 一个 `## 名称` 节 + 紧随其后的 ```yaml 块 + 其余正文（长描述）。

````markdown
# 人物设定

## 林越

```yaml
id: lin-yue
role: protagonist
goal: 上山问清父亲的死因
fear: 发现父亲确实背叛了师门
obsession: 断剑不离手
weakness: 受不得激
camp: protagonist-camp
```

十六岁，瘦，左手虎口有旧疤……

## 守门弟子

```yaml
id: shoumen-dizi
role: gatekeeper
```
````

- `id` 缺失时按标题 slug 补；`id` 重复时**报错**（不猜）。
- 人物 yaml 键：`id` `role` `goal` `fear` `obsession` `weakness` `camp` `description`（可选）。
  其余正文拼进 `description`。
- 世界观 yaml 键：`id` `kind`（`place|faction|power-system|item|history|rule`）`cost` `limits`
  `name`（可选，缺省用标题）。其余正文拼进 `detail`。
- **代价与限制是 SOP 的硬要求**：缺 `cost`/`limits` 的规则继续由 `worldGaps` 报缺口，
  行为不变。

### 3.4 `分卷大纲.md`

````markdown
# 分卷大纲

## 第 1 卷 山门

```yaml
number: 1
title: 山门
goal: 林越拜入山门并立住脚
conflict: 守门弟子与长老的刁难
climax: 试剑台上断剑认主
endHook: 钟声之后，山门后山传来父亲的剑鸣
chapters: [1, 30]
```
````

- `number` 必填且为正整数；`chapters` 为闭区间数组，缺省 `[]`（该卷章数未定）。
- 卷按 `number` 排序；重复 `number` 视为覆盖同一卷。

### 3.5 `章节大纲.md`

两个固定表格，**表格是这些列的唯一归属**（§4）：

```markdown
---
updatedAt: 2026-09-13T14:20:34.921Z
---

# 章节大纲

## 章节表

| 章 | 标题 | 卷 | 目标字数 | 一句话 |
|---|---|---|---|---|
| 1 | 山门 | 1 | 3000 | 林越抵达山门 |

## 情绪节拍表

| 章 | 类型 | 一句话 |
|---|---|---|
| 3 | shuang | 断剑第一次发烫 |
```

- 解析：按 `## 章节表` / `## 情绪节拍表` 定位，跳过分隔行；单元格内的 `|` 用 `\|` 转义。
- 类型取值沿用 `BEAT_KINDS`（`shuang|sweet|burn|tension|info|turn`）。
- 章号重复：**报错**。

### 3.6 `章节/第001章-山门.细纲.md`

```markdown
---
id: chapter-1
number: 1
volume: 1
targetWords: 3000
beats: [tension]
waived:
  infoGap: 本章不设悬念，留到第 3 章
delivered: [plotTask, hook]
---

# 第 1 章 细纲 · 山门

## 剧情任务

…

## 冲突

…

## 情绪回报

…

## 信息差

…

## 章末钩子

…
```

- 六个小节名固定：`剧情任务` `冲突` `情绪回报` `信息差` `章末钩子`；`beats` 与
  `waived`/`delivered` 在 frontmatter。
- 小节缺失 = 该字段为空（与现在的"未写"等价），继续由 `missingContract` 报缺口。
- 标题以 `细纲` 结尾的行不参与正文解析。

### 3.7 `章节/第001章-山门.md`

```markdown
---
id: chapter-1
number: 1
status: drafting
wordCount: 3120
updatedAt: 2026-09-13T14:20:34.921Z
---

# 第 1 章 山门

（正文，原样保留换行；第一个 `# ` 一级标题之前的内容不算正文）
```

- `status` 取值沿用 `CHAPTER_STATUSES`（`planned|drafting|revised|final`）。
- **`wordCount` 是派生值**：工具读入时按正文重算，写文件时按重算结果回填；人不填也不影响。
  人若填了错值，以重算为准（不做"文件为准"的例外——它是派生量，不是内容）。

---

## 4. 数据归属（一条数据只有一个家）

| 数据 | 归属文件 | 说明 |
|---|---|---|
| `title` `premise` `genres` `pov` `language` | `.novel/novel.json` | 项目元数据 |
| `platform` `pitch` `baselines` `writing` | `.novel/novel.json` | 商业框架、校准中位、写作参数 |
| `readings[]` `iterations[]` `verifications[]` `reviews[]` | `.novel/novel.json` | 反馈与证据链：要被阈值计算，必须原子 |
| `links{}`（伏笔台账） | `.novel/novel.json` | "承诺"带状态与回收章，参与卷末门禁 |
| `logline` `acts[]` `minimal` `fullOutlineDone` | `全书大纲.md` | |
| 人物条目 | `人物设定.md` | |
| 世界观条目 | `世界观设定.md` | |
| 分卷条目 | `分卷大纲.md` | |
| 章号、标题、所属卷、目标字数、节拍（章级一句话） | `章节大纲.md` | 计划层 |
| 六字段契约、`beats`、`waived`、`delivered` | `章节/*.细纲.md` | 契约层 |
| 正文、`status` | `章节/*.md` | 产出层（`wordCount` 是派生量） |
| 索引与摘要（§5） | `.novel/novel.json` | 由工具维护，**不作为内容来源** |

**注意现状里的两处"节拍"**：`outline.beats[]`（全书节拍表：章号+类型+一句话）与
`chapter.beats[]`（契约字段：本章携带的类型集合）本来就是两条记录，改造后前者在
`章节大纲.md` 的节拍表，后者在细纲的 frontmatter，保持互不推导。

---

## 5. `novel.json` 的形态（schemaVersion 3）

```jsonc
{
  "schemaVersion": 3,
  "meta": { "title": "…", "premise": "…", "genres": ["…"], "pov": "…", "language": "…" },
  "platform": { … },
  "pitch": { … },
  "baselines": { … },
  "writing": { … },
  "links": { "…": { … } },
  "readings": [ … ],
  "iterations": [ … ],
  "verifications": [ … ],
  "reviews": [ … ],
  "index": {
    "outlineFile": "全书大纲.md",
    "castFile": "人物设定.md",
    "worldFile": "世界观设定.md",
    "volumeFile": "分卷大纲.md",
    "chapterPlanFile": "章节大纲.md",
    "chapters": {
      "chapter-1": {
        "number": 1,
        "title": "山门",
        "bodyFile": "章节/第001章-山门.md",
        "outlineFile": "章节/第001章-山门.细纲.md",
        "bodyHash": "sha256:…",
        "outlineHash": "sha256:…"
      }
    },
    "files": { "全书大纲.md": "sha256:…", "章节大纲.md": "sha256:…" }
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- 顶层五个文件名可被配置覆盖（`Config.storageLayout`），但默认如上；索引是**唯一**记录
  实际路径的地方。
- `hash` 的用途是**跳过未变文件、发现外部改动**，不是冲突拦截（冲突策略是"文件为准"）。
- 元数据文档**仍然**是一次版本守卫写（`replaceIfVersion`），因为它是索引与证据链的家。

---

## 6. 读 / 写路径

### 6.1 读

```
store.read()
  → 读 novel.json（版本守卫用）
  → 按 index 读各 Markdown 文件；hash 未变的文件用上次解析结果（进程内缓存）
  → 组装 NovelState（core 的结构体）
  → 若某文件语法坏：抛 NovelStoreError，消息里带上文件路径与解析器的具体抱怨
```

- 索引缺失/过期（例如目录里有索引未登记的文件）：**扫描一次目录**按 frontmatter `id`
  认领文件，补进索引并回写元数据；孤儿文件（无 frontmatter id）报 warning，不删。
- 人在编辑器里新增一章文件：下次读取时被认领（这是"文件为准"的自然结果）。

### 6.2 写

```
store.update(mutate)
  → 读（§6.1）
  → next = mutate(state)
  → 按 §4 归属做**结构化 diff**，得出需要写的文件集合
  → 逐个写入（每个文件写前重新 stat + 比对 hash；不一致就重新读入并重放该字段……
     本次实现取简化：直接以 next 覆盖，因为策略是"文件为准"且在同一个 update 内
     的并发窗口极小）
  → 写 novel.json（元数据 + 刷新索引/哈希，一次 replaceIfVersion）
  → 任何一步失败：抛 NovelConflictError/NovelStoreError，消息里列出**已写成功**与
     **未写**的文件清单
```

- 写入顺序：内容文件（大纲/设定/章节）→ 元数据。理由是元数据里的索引是"指路牌"，
  宁可短时间指向旧内容，也不要指向不存在的文件。
- 章节标题/章号变化 → 内容写新文件 + 删旧文件 + 更新索引（`rename` 优先，失败再 copy+delete）。

### 6.3 目录卫生

- 工具**只**写 §2 树里的文件；不写临时文件、不写锁文件。
- 派生文件（`manuscript.md`、`templates/*.json`、`reviews/*.md`）行为不变。

---

## 7. 迁移

1. 读到 `schemaVersion: 2`（内容仍在 JSON 里）：
   - **先备份**：把原文写到 `.novel/novel.v2.backup.json`（已存在则不覆盖）。
   - 按 §2/§3 生成全部 Markdown 文件。
   - 生成 `schemaVersion: 3` 的元数据（含索引与哈希），写回 `novel.json`。
   - 输出一行迁移报告（生成了哪些文件、章节数）。
2. 读到 `schemaVersion: 1`：先按现有 `migrateV1` 升到 2，再走上面的路径。
3. 读到 `schemaVersion: 3`：正常读取。
4. 备份文件永远保留（人的草稿不能因为一次升级消失）。

---

## 8. 影响面清单（实现顺序建议）

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/core/markdown.ts`（新） | frontmatter 解析/序列化（**不引入依赖**，自己写 30 行受限 YAML：标量、字符串数组、一层映射）、小节切分、表格读写、`hashContent` |
| 2 | `src/core/types.ts` | `NOVEL_SCHEMA_VERSION = 3`；新增 `StorageIndex` 类型；`NovelState` 增加 `index` |
| 3 | `src/core/novel.ts` | `parseMetadata` / `serializeMetadata`；`migrateV2`；`emptyNovel` 带空索引 |
| 4 | `src/host/store.ts` | 多文件读写、组装/拆解、索引刷新、目录认领、失败清单 |
| 5 | `src/host/tools.ts` | 写路径改为"改 state"不变（store 负责落盘），但 `novel_write`/`novel_plan` 的字段归属按 §4 对齐；`novel_status` 的读数不变 |
| 6 | `src/client/index.tsx` | 面板读元数据 + 按需读章节文件（通过 `ctx.remote.workspaceFiles`） |
| 7 | `test/*` | 断言从 `novel.json` 改为断文件；新增 §9 的用例 |
| 8 | 文档 | `docs/architecture.md` 存储一节、README 中英、host README、`docs/sop.md` 的存储说明、SKILL/INSTALL 里"项目文档"的措辞 |
| 9 | 打包 | `scripts/pack.mjs` 不需要改工具表；确认 INSTALL 措辞 |

---

## 9. 必须补的测试

- **往返**：每个文件 结构体 → Markdown → 结构体，字段全等（含空字段、含 `|`、含多行正文、
  含中文标点）。
- **frontmatter 边界**：空文件、只有 frontmatter、缺 frontmatter、YAML 缩进错、
  `chapters: [1, 30]` 与 `chapters:\n  - 1` 两种写法都要吃下。
- **表格**：单元格含 `\|`、含多行、缺列 → 报错而不是错位。
- **id 重复 / 章号重复** → 报错。
- **外部改动采纳**：手改 `章节/第001章-山门.细纲.md` 的 `## 章末钩子` → 下次 `novel_write`
  的兑现回报按新钩子判定。
- **语法坏掉**：把正文文件 frontmatter 写坏 → 工具**报错并指名文件**，且**不改动该文件**。
- **迁移**：v2 文档 → 生成全部文件 + 备份 + v3 元数据；再读一次幂等。
- **重命名**：改章节标题 → 文件改名、旧文件消失、索引指向新路径、`章节大纲.md` 同步。
- **现有 187 个 spec**：逐个改断言目标（不是删测试）；SOP 流程的端到端用例必须继续全绿。

---

## 10. 与既有承诺的关系（不要打破的东西）

1. **工具仍不改写正文**：`novel_review` 的改写稿仍只落 `.novel/reviews/*.md`；只有
   `novel_write` 能写 `章节/*.md`。
2. **阈值仍只认元数据**：`readings`/`iterations`/`verifications` 留在 `novel.json`，
   `novel_metrics` 的裁决不因为这次改造而变成读 Markdown。
3. **越界保护不变**：所有路径仍由 `NovelStore.contain()` 做路径算术判定，拒绝逃出工作区根。
4. **模型草稿不是事实**：`novel_review` 的 `save=true` 语义不变，只是落点是新文件。
