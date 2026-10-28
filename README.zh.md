# ai-novelist

[English](README.md) | 中文

一个把 DeepSeek Harness 变成 **AI 网文创作台** 的 **DSH 插件**——更准确地说，它把一套网文
生产 SOP 变成可执行的东西：agent 拿到的是真实项目文件、带门禁的策划流水线、设定集、逐章契约、
按同类中位校准的指标台账，以及成稿导出，而不是把一整本小说塞在上下文里。

面向 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.2.0-rc.2`。

## 它带来了什么

**九个面向模型的工具**，一个工具管一件事，与 SOP 的阶段一一对应（见下文「这套工具实现的 SOP」），
另有一个刻意站在阶段之外。其中**八个是算出来的**——阈值、门禁、算术，每次运行结果完全一致；第九个 `novel_review` 是**问出来的**：
把文笔判断交给大语言模型，因为那是计数器决定不了的事。它只在存在模型路由的环境里注册。

九个工具里有**两个是为了补上一个具体失败而存在的**：从"用户给一句灵感"到"写完前几章"之间，原本没有任何检查点。
`novel_confirm` 记录**只有用户能关的关卡**——正文之前的**设定确认**（而且设定本身要按 立意 → 世界观 → 人设 → 全书大纲 → 分卷大纲 逐层谈定，一次只给一层），
和黄金三章（第 1–3 章）成稿之后、第 4 章之前的**文风复核**；
`novel_write` 是全部工具里**唯一的硬门禁**：立意未确认、或《写作风格》七要素没写全，都拒绝写正文，
并在错误里指出打开它的调用。

| 工具 | SOP 阶段 | 负责什么 |
|---|---|---|
| `novel_init` | 一 策划 | 项目与商业框架——平台、付费/免费、频道、品类、目标读者、变现方式——以及此后所有指标比较所依据的校准中位（`baselines`，近 30 天同品类指标中位），还有写作参数：细纲窗口、开篇门禁章、存稿目标、细纲上限。**篇幅四问**（总字数、单章字数、是否分卷、分几卷）必须问过用户再录：未问到的项由工具列成待问清单每一步重复，总章数由总字数 ÷ 单章字数推导，三者与卷数互不自洽时报警。 |
| `novel_plan` | 一/二/三/四 | 策划流水线：`competitor`、`pitch`、`world`、`outline`、`volume`、`chapter`、`beat`、`opening`、`naming`，以及 `launch`——阶段三对开篇包的人工上线决策。`go` 解锁完整骨架；`revise` 与 `abandon` 必须写明回退目标与放弃条件，否则拒绝记录。 |
| `novel_confirm` | 一/五 | **只有用户能关的关卡，设定按层依次确定。** 顺序固定：立意（`kind="settings"`/`"premise"`）→ 世界观（`"world"`）→ 人物设定（`"cast"`）→ 全书大纲（`"outline"`，含《写作风格》七要素）→ 分卷大纲（`"volume"`）；`kind="style"` 是黄金三章之后的**文风复核**——把第 1–3 章交给用户，问文风/表达方式/遣词用句要不要调整，要调就先写回大纲、再改受影响的章节，然后记录并确认。**一次只把一层交给用户**：上一层没确认时，后一层的 `discuss`/`confirm` 会被拒绝——一次把整套设定抛给用户，正是这套顺序要避免的事；《写作风格》没写全时，「全书大纲」这一层也拒绝确认。`status`（默认）逐层报出进度与「现在该谈哪层」；`discuss` 记录**一轮讨论**——这一轮给用户看的东西（`proposal`）与用户**实际回答的原话**（`feedback`，必填：没有用户原话的一轮会被拒绝记录）；`confirm` 记下用户拍板的这一版：`summary`（此后每章对齐的基准）与 `note`（用户说"可以"的原话）都必填。**立意至少 2 轮，其余每层与文风复核各至少 1 轮**才能确认。不许替用户确认，也不许编造轮次。 |
| `novel_bible` | 一/四/六 | 人物、世界设定与对读者的承诺：`character`、`world`、`link`、`review`。`link` 是一条带埋点、目标回收章、回收方式与状态的承诺；已到回收章仍未回收的会被报出。`review` 还会读每章的时间锚点，算出故事日，把「早于已经到过的日」的章报成逆序（标了「回忆」的倒叙跳过，认不出的写法只报「无法解析」，不瞎猜成逆序）。 |
| `novel_write` | 五 连载 | 单章正文与兑现回报：`write`、`read`、`check`。**流程里唯一的硬门禁工具**：用户未确认立意时拒绝写正文；《写作风格》七要素（`styleTone`…`styleTaboos`）没写全时也拒绝——第 1 章要有写下来的语感基准；黄金三章已有正文而用户未复核文风、**或从未留下过一次去 AI 化诊断**时，拒绝写第 4 章及以后。拒绝信息里写明打开关卡要用的调用。这个"拒绝"正是重点：别处软拦只报告分歧、仍让调用通过，而"模型写完四章、作者一次没被问过"恰恰就是这样发生的。**初稿按目标字数的 125% 写**（去 AI 化与手改会成段删减），成稿再落回 **-5%/+15%**（欠字比超字严重，下限只给 5%）；工具按章节状态选口径核对，并打印两道长度线。发正文时带上 `delivered=[…]`，它会报出细纲哪些字段已兑现、哪些未兑现、哪些细纲本身没写。每次 `write` 与 `check` 还会附上**去 AI 化统计**——段落长度、对话密度、重复句式，以及**对举句计数**（「不是 X，是 Y」及其变体，附两处原文引用）和**负面清单命中**（本书自己写下的禁用写法，逐条比对）：这几项恰是计数器能抓、而模型评审最容易漏掉的 AI 味。每次 `write` 与 `check` 还会跑一遍**确定性校对**：只查「怎么写都是错」的固定词形（帐号→账号、时侯→时候、既使→即使…）与标点形态（`...`、`。。`、中文之间夹半角逗号），报条数，但**不会说「校对通过」**，也**不查** 的/地/得 与敏感词（一个要句法、一个要平台词库）。覆盖正文前会把**上一版正文存档**到 `.novel/versions/` 并在结果里给出路径，所以改稿永远可回退。工具只报症状、从不改写正文，改写由你完成后重新发一遍。 |
| `novel_assess` | 五 按需 | **不是阶段，也不拦任何东西。** 按需的投入评估——作者问「这本书还值不值得写下去」时才启动。`record`（手工抄录一次读数，并报出触发的规则，每条规则都带动作**与范围**；同时可传 `baselines` 就地重新校准中位）、`iterate`（把决定写入台账）、`evaluate`（正式评估：拿读数与校准中位比对，顺带自动回填此前所有未结调整的结果，给出裁决——继续投入 / 换变量后继续 / 切书止损）、`outcome`（手动结项：指定某个读数结掉某次调整，用于自动回填推断不到的情况）、`history`、`rules`。不通过的评估必须写明回退目标与放弃条件，每次评估都必须留下下次评估的约定；全部指标都没有可比中位时，它不给裁决。 |
| `novel_status` | 全流程 | 看板，全部由项目状态派生，不需要维护第二张表：`dashboard`（默认）、`bible`、`plan`、`chapter`，以及 `craft`（取一张写作知识表：`genres` / `platforms` / `hooks` / `payoffs` / `rhythm` / `naming` / `voice` / `continuity` / `submission`，省略 topic 则列出索引）。 |
| `novel_repo` | 六 复盘 | 收尾阶段：`export`（Markdown 成稿）、`submission`（投稿包：作品信息、简介位、前三章细纲与章末钩、投稿前自查表、投稿记录；不代写简介）、`retro`、`asset`、`lesson`、`template`。 |
| `novel_review` | 五/六 判断 | **唯一由模型驱动的工具。** `ai-flavor` 按版本化的去 AI 化 rubric 诊断单章，**并对照这本书自己的《写作风格》与负面清单**；机械统计已数到的症状一并交给它判断，它不必重复计数（加 `rewrite=true` 会额外产出改写稿，但只落成旁挂文件，绝不写进章节）；`opening` 用 SOP 开篇清单体检门禁章；`competitor` 把粘进来的竞品原文拆成 `novel_plan` 能接收的结构；`retro` 读项目自己的数据，提出可复用与要避开的经验。每次调用都记录 provider、model 与提示词版本，并把完整对话写到 `.novel/reviews/`。**模型写的内容除非你显式 `save=true`，不会进台账。** |

**一个 `novelState` 服务**——所有工具与界面共用的、带冲突检查的唯一写入通道，按会话解析。

**两个 Web 界面**——同一份项目的两种视图：会话视图行里的 **看板（Kanban）** 标签页，以及右侧栏中可从侧栏引导页打开的「Novel Composer」标签页。

| 界面 | 位置 | 展示内容 |
|---|---|---|
| **看板** | 会话的视图标签行，紧邻 Chat 与 Trajectory | 一眼看全项目，分两半。上半是**过程文档**：按 SOP 产出顺序各一张卡（立意与核心设定 / 竞品拆解 / 候选书名 / 世界观设定 / 人物设定 / 全书大纲 / 写作风格 / 分卷大纲 / 爽点节拍表 / 开篇工程清单 / 上线决策 / 连载数据 / 完本复盘），每张显示它有没有开始、已经写到什么程度（立意五项、竞品本数、候选组数、人物条目、大纲骨架项数、文风项数、卷数、节拍数、清单项数）、**逐项点名**还欠什么，以及它卡在哪个关卡上（`卡住正文` = 写正文前必须写掉的，`go 之后才做` = 上线决策授权后才投入的）。下半是**章节看板**：四列就是章节生命周期——待写 / 写作中 / 已修订 / 已完成；每张卡片带章节号、标题、所属分卷、字数（未定稿的列按**初稿目标 = 成稿 ×125%** 比，已修订/已完成列按成稿目标比）、节拍，以及细纲还欠什么（缺章末钩子、未答字段）。看板上方是 SOP 阶段与进入下一阶段还缺什么、已写章数、总字数、人物、世界观、未兑现伏笔、候选书名，以及**设定五层（立意 / 世界观 / 人设 / 全书大纲 / 分卷大纲）与文风**逐层的确认状态。 |

看板**只在有小说项目的 workspace 里出现**：当会话所在的 workspace 存在 `.novel/novel.json` 时才会加上这个标签页，没有项目的工作区仍旧只有 Chat 与 Trajectory 两个标签页。它用与 host 写入完全相同的编解码器读取项目，因此只可能滞后于文件，不会与文件不一致；agent 写入后点「重新读取」即可刷新。

### 写作知识（「读起来该像什么」的那一半）

SOP 擅长规定**该规划什么、什么算欠账**，但它教不了**钩子怎么落、爽点怎么排、哪句话一眼像 AI**。这部分放在
[`docs/craft/`](docs/craft/README.md)：十四张原创知识表（赛道、趋势、平台节奏、出海、钩子、爽点、节奏、起名、文风、连贯性、投稿、同人、剧本、教学），并且不必开文件就能取到——
`novel_status detail="craft"` 列出索引，`novel_status detail="craft" topic="hooks"` 返回正文；同一份 Markdown 在打包时
复制进 skill 的 `references/craft/`。这些表**故意不写死平台门槛**：给判断方法，并提醒你核对平台当期公告，因为一条过期的
「签约字数」比没有更糟。

## 这套工具实现的 SOP

工作流本体是 [`docs/sop.md`](docs/sop.md)（爆款网文创作全流程 SOP 3.9），闭环为
**假设 → 验证 → 放大 → 复盘 → 复用**：先用竞品拆解与唯一记忆点立假设，把开篇包交给真实读者，
对开篇包记下一次人工的上线决策（go / 改后再说 / 放弃），只有 `go` 才搭完整骨架，连载中按需做数据评估与迭代，
完本后沉淀成可复用的结构。

这里有两条轴，其中只有一条是流水线。**流水线**——策划、开篇包、上线决策、完整骨架、连载——
只按已计划与已写出的内容推进，从不等一个平台数字。**数据评估**（`novel_assess`）则由作者在问
「这本书还值不值得写下去」的那一刻启动，通常是平台上已有数字可以手工抄录之后；它才是把读数变成
继续投入 / 换变量后继续 / 切书止损的那一步。没有任何门禁依赖它：一次都没测过的项目是正常项目，
没有读数从来不是停下来的理由。

插件的价值在于让这套 SOP **可执行**，而不是停在建议层面：

- 每一步的产出都是项目文档里的字段，「该记的记了」，不会只活在正文里；
- 阈值由校准中位算出，而不是心算——`novel_init` 录中位，`novel_assess` 在评估时套用倍数；
- 阶段由项目派生，所以工具任何时候都在汇报项目真实所处的位置，以及下一阶段还缺什么；
- SOP 认为你还没到那一步时，调用**依然成功**，只是在返回值里带上 `warnings` 说明缺什么。这道
  软拦从不拒绝调用。只有两处刻意的例外，都是为了不让决策变成走过场：`novel_plan operation="launch"`
  给出的不是 `go` 时，必须写明回退目标与放弃条件；`novel_assess operation="evaluate"` 必须留下
  下一次评估的约定，且全部指标都没有可比中位时不给裁决。

它是怎么搭起来的、为什么这么搭，见 [`docs/architecture.md`](docs/architecture.md)；动手改之前先读。

### 它不做什么

SOP 明确说了哪些事属于人和平台，这里也直说：

- **它不编造指标。** 数字来自平台后台、编辑、试读样本或人的判断；工具只负责登记、比较、给出
  动作与范围、并提醒。没人录入读数，就没有读数。
- **八个计算型工具不评价文笔。** 兑现回报比较的是「正文与它自己的细纲」，去 AI 化提示是可数的统计
  （段落长度、对话密度、重复句式），不是对语感的评判；合规是你要逐项确认的清单，不是扫描器报一句
  「干净」。`novel_review` **确实会评价**——正因如此它是独立工具、独立记录：结论引用原文、写明所用
  模型与 rubric 版本，并且不进入任何会被阈值当作依据的台账。
- **它不改已发布章节。** 它记录一次迭代的范围与理由、报出到期未回收的承诺；改不改、怎么改，始终
  由作者决定。
- **它自己不测量任何东西。** 没有平台 API、没有爬虫、没有埋点。

## 安装

在你想启用创作台的 DSH profile 下执行（浏览器界面用 `web`）：

```sh
pnpm install                      # 在本仓库执行一次
dsh plugin --profile web add -w "$(pwd)/packages/novelist-bundle"
```

`-w` 不能省。`dsh plugin` 把 `add` 之后的参数原样转发给在 profile 目录里运行的 pnpm，而那个
目录本身就是一个 pnpm workspace 根（`pnpm-workspace.yaml` 就在它的 `package.json` 旁边），
所以 pnpm 只接受带 `--workspace-root` 的依赖写入。

随后 `dsh plugin add` 会对齐 `dsh.profile.bundles`：由于 `@ai-novelist/novelist-bundle` 声明了
`dsh.bundle.patch`，它会自动加入该 profile 的层叠栈。重启 `dsh web` 后，新会话即可看到八个
计算型工具，有可用模型时 `novel_review` 一并出现，侧栏引导页出现创作台标签页。

结尾这个 spec 是**包名而不是命令名**——`dsh plugin` 把它之后的参数原样转发给 pnpm，所以它
必须是 pnpm 能解析的包名。`@ai-novelist/novelist-bundle` 是 *bundle*（npm scope 为
`@ai-novelist`、包名为 `composer`）；它拉进来的 *插件* 是 `@ai-novelist/novelist-skill`，
加载时的行 id 为 `ai-novelist`。

不启动会话也能确认组合结果：

```sh
dsh --profile web --dump-config | grep -A2 ai-novelist
```

卸载：

```sh
dsh plugin --profile web remove -w @ai-novelist/novelist-bundle
```

> **正在改这个插件？** 改完源码执行 `pnpm run build`（或
> `pnpm --filter @ai-novelist/novelist-skill run build --watch`）。profile 链接的是本仓库，
> host 半边重新构建即可生效；浏览器半边由 `packages/novelist-skill/lib/client.js` 提供，
> 需要刷新页面。profile 加载的是 `lib/`，所以没重新构建前，跑着的 `dsh web` 还是上一版工具。

## 目录结构

```
packages/
  novelist-bundle/                # BUNDLE  @ai-novelist/novelist-bundle
    cordis.patch.yml              #   把插件行插入 profile 插件树
  novelist-skill/                 # PLUGIN  @ai-novelist/novelist-skill
    src/core/                     #   纯领域逻辑：类型、状态、细纲校验、指标规则、
                                  #   兑现回报、复盘组装、工作区判定
    src/host/                     #   ctx.fs 存储、按会话解析、工作区视图、
                                  #   提示词片段、工具注册
    src/client/                   #   Web 界面的两个视图（看板 + 右侧栏标签页），
                                  #   构建为 lib/client.js
    src/index.ts                  #   Cordis 插件本体（name / inject / Config / apply）
```

目录名与包名一一对应：插件是 `@ai-novelist/novelist-skill`，所以放在
`packages/novelist-skill`；bundle 是 `@ai-novelist/novelist-bundle`，所以放在
`packages/novelist-bundle`。

之所以拆成两个包：bundle 的 patch 只能「插入一行、行里写着插件包名」，而一个包无法为
自己插入一行。

host 包另有一份开发者参考
[`packages/novelist-skill/README.md`](packages/novelist-skill/README.md)：
模块地图、schema v5 数据模型，以及贡献者不能破坏的几条不变量。

## 小说存放在哪里

小说就是**工作区里可读可改的 Markdown**。`.novel/novel.json` 只保留必须原子移动的部分——
立意与商业框架、指标读数与迭代台账、伏笔台账，以及一份「内容文件在哪」的索引。作者要读、要改的
东西全都在能直接打开的文件里：

```
novel-workspace/
  全书大纲.md            # 一句话、故事六要素（时间/地点/起因/经过/结果）、
                        # 叙事骨架（故事梗概/主角成长线/伙伴成长线/反派成长线/阵营演变/对抗副本/得失）、
                        # 金手指（名称/归属/规则/代价/限制/成长曲线/首次亮相）、
                        # 完整大纲、三幕、最小可行大纲（完整大纲目标字数 ≈ 总字数/100）
  世界观设定.md          # 一个条目 = 一条设定：kind、detail、代价与限制（仅 rule/power-system），
                        # 以及 parent / level / volume / relations（分层世界观：谁包含谁、第几层、第几卷起、与谁结盟）
  人物设定.md            # 一个条目 = 一个 ## 小节，按档排序：主要角色写全 spine，配角写身份/欲望/性格/说话方式，
                        # 路人（scope: cameo）只要「他是谁 + 首次出场章」，不计欠账（见 docs/sop.md C29）；
                        # 主要角色另有 relations（与其他人物的关系）
  章节大纲.md            # 全书层：开篇工程清单 + 各卷文件的索引（哪一卷从第几章开始）
  竞品拆解.md            # 每条 = 一本同榜书，十二个字段可读可改（20–50 本）
  分卷大纲/
    第1卷.md             # 一卷一个文件：先卷内节奏（目标字数 ≈ 本卷字数/50），
                         # 再七个叙事要素（本卷梗概/主角成长/反派成长/阵营演变/核心对抗/代价与收获）各自一个 ##；
                         # 独立目标/矛盾/高潮/卷末钩子写在 frontmatter
    第2卷.md             # 改后面的卷，不必重写前面的卷
  章节大纲/
    第1卷.md             # 本卷的章节表 + 情绪节拍表（每章契约目标字数 ≈ 单章字数/5）
    未分卷.md            # 还没排卷的章节
  章节/
    第001章-山门.md      # 正文
    第001章-山门.细纲.md # 契约：剧情任务、时间、地点、关键转折、代价与收获、冲突、情绪回报、信息差、章末钩子
  .novel/
    novel.json            # 元数据 + 索引（schemaVersion: 5）
    novel.v2.backup.json  # 只在迁移后出现，永不覆盖
    manuscript.md         # 由 novel_repo operation="export" 写出
    submission.md         # 由 novel_repo operation="submission" 写出
    templates/            # 由 novel_repo operation="template" 写出
    reviews/              # 模型评审记录与改写稿
```

**传统六要素与网文六要素都有名字**（SOP 3.9 §1.7）：时间/地点/起因/经过/结果是 `全书大纲.md` 的
`## 故事六要素`，人物由人物设定承担；每章另有 `时间`/`地点` 两个锚点（缺了报出，但不让旧章节算欠账）；
金手指是 `## 金手指` 七字段；世界观用 `parent`/`level`/`volume` 分层；节拍表与章节契约不一致、卷末没有节拍、
主要角色没写关系，都会被 `novel_plan`/`novel_bible`/`novel_status` 点名。

**大纲的检查顺序是先故事、再爽点、最后字数**（SOP 3.9 §1.5）：三层大纲各有具名的叙事要素字段，
缺一项就报一项，且**在这些项报完之前不报字数**——一份按清单填满、字数达标却讲不出整个故事的大纲，
会被判为"未写梗概"，而不是"达标"。

**以文件为准**：手工改任何一个文件，下次读取就采纳你写的内容并刷新索引。唯一的护栏是语法——
文件解析不了时，工具**报错并指名文件与原因**，且**绝不改动那个文件**，因为对坏文件瞎猜正是丢稿的
方式。唯一例外是 `wordCount`：它是派生量，每次读取按正文重算、每次写入回填，人填了错值以重算为准。

写入顺序是**先内容文件、后元数据**：索引在一次写入期间可能短暂指向旧内容，但绝不会指向不存在的
文件。写入失败时会报告**哪些文件已写、哪些没写**。

文档版本是 `schemaVersion: 5`。**每一卷大纲、每一卷的章节表各自成文件**，因为连载中改的是后面的卷：
改第 7 卷不会重写第 1–6 卷，文件名只有卷号（`分卷大纲/第1卷.md`、`章节大纲/第1卷.md`），改卷名不会
挪动文件；1000 章的书里排第 341 章只碰一个文件，而不是重写一张 1000 行的表。

读到 v4（章节表还与开篇清单挤在一个 `章节大纲.md` 里）会按「卷」列把章节表与情绪节拍表拆成一卷一个
文件，开篇工程清单与一份各卷索引留在原文件里；读到 v3（各卷还挤在一个 `分卷大纲.md` 里）会先把分卷
合集拆开，再拆章节表。两处都是**先写新文件、后改原文件**，中断了下次读取会重跑。读到 v2（内容还在
JSON 里）会先备份原文到 `.novel/novel.v2.backup.json`（已存在则不覆盖），再生成全部 Markdown 文件并写回
当前版本元数据；读到 v1 会先升到 2 再走同一条路。**备份永远保留**，人的草稿不会因为一次升级消失。
无法识别的版本会被拒绝，而不是猜着读。

### 一个目录怎么才算「网文工作区」

DSH 里的 **workspace** 是宿主登记的一个目录；**session** 记录自己运行在哪个目录（`cwd`）。
插件按 **session 的 workspace** 解析项目，**绝不**按服务器启动时所在的目录——所以一个
`dsh web` 服务可以承载多部小说各自的会话，互不干扰。

插件对每个 session 的工作区做一次判定，并据此行事：

| 发现 | 判定 | 结果 |
|---|---|---|
| `.novel/novel.json`（元数据 + 索引） | `novel` | 原样采用；旁边的内容文件才是小说本体。工具与提示词立即生效。 |
| 内容 `.md` 文件 | `novel` | 以文件为准：你的改动下次读取即被采纳。 |
| 只有 `.novel/` 目录、还没有文档 | `novel` | 视为网文工作区：先建一份空文档，立意留给 `novel_init` 填。 |
| 三个以上章节形态的文件（`001-*.md`、`第3章.md`） | `novel` | 识别为已有草稿，在旁边补建项目文档。 |
| 创作类笔记（`创意整理.md`、`人物设定.md`、`story-outline.md` 等） | `novel` | 识别为「一本书的文件夹」：建一份空项目文档，标题取文件夹名。 |
| 大纲 + 一章，或两个小说形态的文件 | `novel` | 同上。 |
| 空目录 | `fresh` | **不碰**。让 agent 在这里开一本（或配 `adoptEmptyWorkspace: true`）。 |
| 代码仓库（`package.json`、`.git` 等） | `plain` | 不管里面有多少 Markdown 都不碰。工具保持静默，提示词里也会说明。 |
| 其他 | `plain` | 不碰。 |

插件挂载时判定**部署自己的目录**，其余目录在**会话出现时**判定。`novel` 工作区随后会在每一步的
system prompt 里注入一段运行时上下文，说明工作区类型并汇报当前进度（章节数、字数、未写章节数、
设定集规模）。因此打开一本小说不需要任何「发现」回合，而在别的目录里开的会话，也绝不会被安上
服务器启动目录的判定或数字。

#### 「自动初始化」到底写了什么，怎么撤销

自动初始化**只写空脚手架**：`.novel/novel.json`，标题取文件夹名，其余剧情字段全空。不碰你写的任何
文件，不会覆盖已有内容（写入意图是 `createIfAbsent`），也不会替你编造任何创作决定——立意、中位线、
卖点、章节都不填。这正是它的意义：脚手架一落盘，工具、提示词段落和看板 tab 从第一条消息起就存在，
不必等谁想起来调 `novel_init`。

如果它认领了一个你并不想当小说的目录，删掉即可，插件下次判定就回到 `plain`：

```sh
rm -rf <那个目录>/.novel
```

想让它别这么主动，把 `workspaceMode` 设成 `auto`（只认已有标记的项目）或 `off`（从不写入）。

### 一个对话写一部小说

这里没有「切换项目」的工具，因为项目跟着会话走：在界面上打开另一个 workspace，工具就自动解析到
它的根目录。会话没有记录 `cwd` 时，才回退到配置的 `workspaceRoot`，最后才是进程目录。
`novel_status` 汇报的是**当前调用会话**所在工作区的判定，那是关于「我正在改哪一本」的权威答案。

判定刻意保守：带几个 Markdown 的代码仓库**不算**草稿，只认章节形态文件名，单个通用笔记什么都算不上，
而且**不会**往空目录里写任何东西，除非你明确要求。若想无视探测、固定某个目录：

```yaml
# 你的 profile 的 cordis.patch.yml
- id: ai-novelist
  config:
    workspaceRoot: /Users/me/novels/qingyun   # session 未记录 cwd 时的回退
    workspaceMode: signal                     # signal（默认）| auto | novel | off
    adoptEmptyWorkspace: false                # true：启动时就在空目录里建好项目
    reviewProvider: ''                        # 留空：评审跟随当前会话的模型
    reviewModel: ''                           # 两项都填：把 novel_review 固定到某个模型
    reviewTimeoutMs: 120000                   # 单次评审的超时上限
    reviewMaxTokens: 8192                     # 单次评审的输出预算（tokens）
    reviewReasoningEffort: off                # off | low | high | max | ''（跟随适配器默认）
```

`novel_review` 是唯一需要模型的工具，路由按此顺序解析：调用参数里的 `provider`/`model`
（**两项必须同时给**，只给一项会被明确拒绝，而不是静默回落）→ 配置的
`reviewProvider`/`reviewModel` → 当前会话正在用的模型。三者都没有时它**不注册**，
于是一个没有模型的环境仍然有八个可用于规划与记账的工具，而不是九个坏工具——但正文本身、以及第 4 章之前必须留下的那次去 AI 化诊断，仍然需要模型：没有模型的环境适合规划一本书，不适合写一本书。

`reviewReasoningEffort` 默认 `off`，原因值得知道：支持推理的路由在调用方不指定时会套用自己的
默认等级（DeepSeek 是 `high`），而推理 tokens 与正文**共用** `reviewMaxTokens` 这一个上限。
评审这种一次性打分调用可能把整个预算烧在思考上，一个字的正文都没写就结束。该等级只在该路由
明确声明时才发送，所以把评审固定到非推理模型也是安全的。整章改写被截断时，调大
`reviewMaxTokens`。

`off` 在启动时什么都不写——工具仍然注册，用户明确要求时 `novel_init` 依旧可用。

## 打包分发

`pnpm run dist` 会先构建、再在 `dist/` 下产出两个分发包，两者携带**同一套九个工具**——工具代码
一律从本仓库构建产物复制，不重写。

### 一、DSH plugin 分发包 —— `dist/dsh-plugin/ai-novelist-<版本>.tgz`

**一个 tarball，一个包。** `@ai-novelist/novelist-bundle` 同时是 bundle、plugin 与浏览器半边：

- 它声明了 `dsh.bundle.patch`，这正是 DSH 把它追加进 `dsh.profile.bundles` 的依据；
- 它的根导出（以及 `./host` 别名）就是注册九个工具的那个模块；
- 它的 `./client` 导出是 Web 界面半边，以 `window.__ModuleLoader__` 形式提供。

```sh
pnpm run dist
dsh plugin --profile web add -w dist/dsh-plugin/ai-novelist-0.3.0.tgz
```

tarball 里带着构建好的 `lib/`，所以目标机器只需要 Node 和 DSH——不用连仓库、不用联网安装、
也不用现场构建。

> **它满足的两条约束都是实测换来的。** 第一，patch 的行名必须是**裸包名**：客户端扫描器用
> "精确包名"规则推导包根，行名写成 `@ai-novelist/novelist-bundle/host` 虽然能解析插件，却会让浏览器
> 半边**静默地**不进启动清单。第二，分发包必须是**一个**包：pnpm 的 tarball 安装只认压缩包内的
> 一个包——嵌套的 `file:./sub` 报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`，而并列两个包
> （`file:../sibling`）实测只解出其中一个。源码仓库保留两个包，因为它们由不同工具构建、面向不同
> 目标；只有分发时合并，并且打包步骤会重建浏览器半边，让它的注册 id 与出厂的包名一致。

### 二、SKILL 标准分发包 —— `dist/skill/ai-novelist/`

一个可移植的 Agent Skill 目录包：`SKILL.md` 带 DSH 文件系统 provider 会解析的 frontmatter 与
**全部九个工具的清单表**，`references/` 放工作流、工具参考、由代码生成的阈值与十四张写作知识表，
`scripts/` 放安装脚本，`tools/` 放与分发包一相同的那个包。两个分发包都带 AGPL-3.0 的 `LICENSE`。

```sh
node dist/skill/ai-novelist/scripts/setup.mjs --profile web
```

把整个目录放进任一被扫描的 skill 根目录即可被发现——项目级用 `<git 根>/.dsh/skills/` 或
`<git 根>/.agents/skills/`；用户级用 `$DSH_HOME/skills/` 或 `~/.agents/skills/`。

> **SKILL 包里的工具不是由 skill 声明的。** skill 的本质是指令加资源：它的 frontmatter 只接受
> `name`、`description`、`whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`，
> **没有任何字段能注册工具**。工具只有在某个插件把它注册到 `ctx.tools` 之后才存在。所以这个
> skill 包同时携带代码**和**安装脚本，并在 `SKILL.md` 里把这件事说明白，而不是让人误以为工具
> 是白来的。它的 `metadata.tools` 与正文的「九个工具」表都把九个工具列全了。

## 开发

```sh
pnpm install
pnpm run check        # build → typecheck → test
pnpm run build        # tsc（host）+ tsdown（浏览器产物）
pnpm run dist         # 构建，然后产出 dist/dsh-plugin 与 dist/skill
pnpm test             # vitest：SOP 全流程端到端，外加存储、工作区、提示词、
                      # 看板投影与浏览器产物的用例
pnpm run craft        # 从 docs/craft/ 重新生成 src/core/craft.generated.ts
pnpm run fixture /tmp/ain-fixture
                      # 生成一个示例 schema-5 小说项目（四列都有章节），
                      # 供手工查看界面
```

想看到看板：把本 bundle 装进 DSH profile，启动 `dsh web`，然后打开一个**位于该示例目录**的会话
——看板是会话视图行的一部分，所以它只会在 workspace 里确实有小说项目的会话中出现。

[`docs/sop.md`](docs/sop.md) 是工具所实现的工作流本体——阶段、字段与阈值的权威清单。
[`docs/craft/`](docs/craft/README.md) 是写作知识库：改 Markdown 后跑 `pnpm run craft`，
它既生成 `novel_status detail="craft"` 用的模块，也留下打包时复制进 skill 的原文件。
动手改之前请先读 [`docs/architecture.md`](docs/architecture.md)：它讲了这个插件是怎么搭起来的、
以及为什么这么搭。

## 许可证

AGPL-3.0-only
