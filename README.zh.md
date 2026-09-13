# ai-webnovel-composer

[English](README.md) | 中文

一个把 DeepSeek Harness 变成 **AI 网文创作台** 的 **DSH 插件**——更准确地说，它把一套网文
生产 SOP 变成可执行的东西：agent 拿到的是真实项目文件、带门禁的策划流水线、设定集、逐章契约、
按同类中位校准的指标台账，以及成稿导出，而不是把一整本小说塞在上下文里。

面向 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.5-rc.1`。

## 它带来了什么

**九个面向模型的工具**，一个工具管一件事，与 SOP 的阶段一一对应（见下文「这套工具实现的 SOP」）。
其中**八个是算出来的**——阈值、门禁、算术，每次运行结果完全一致；第九个 `novel_review` 是**问出来的**：
把文笔判断交给大语言模型，因为那是计数器决定不了的事。它只在存在模型路由的环境里注册。

| 工具 | SOP 阶段 | 负责什么 |
|---|---|---|
| `novel_init` | 一 策划 | 项目与商业框架——平台、付费/免费、频道、品类、目标读者、变现方式——以及此后所有指标比较所依据的校准中位（`baselines`，近 30 天同品类指标中位），还有写作参数：细纲窗口、开篇门禁章、存稿目标、细纲上限。 |
| `novel_plan` | 一/二/四 | 策划流水线：`competitor`、`pitch`、`world`、`outline`、`volume`、`chapter`、`beat`、`opening`、`naming`。 |
| `novel_bible` | 一/四/六 | 人物、世界设定与对读者的承诺：`character`、`world`、`link`、`review`。`link` 是一条带埋点、目标回收章、回收方式与状态的承诺；已到回收章仍未回收的会被报出。 |
| `novel_verify` | 三 验证 | 验证门禁：`round` 记录一轮小成本测试及其指标，返回裁决（`pass` / `partial` / `fail`）；`assess` 只比对读数（默认最近一次），不新记一轮。 |
| `novel_write` | 五 连载 | 单章正文与兑现回报：`write`、`read`、`check`。发正文时带上 `delivered=[…]`，它会报出细纲哪些字段已兑现、哪些未兑现、哪些细纲本身没写，以及字数是否落在目标区间。每次 `write` 与 `check` 还会附上**去 AI 化统计**（段落长度、对话密度、重复句式）——工具只报症状、从不改写正文，改写由你完成后重新发一遍。 |
| `novel_metrics` | 五 放大 | 数据闭环：`record`（录入一次读数，并报出触发的规则，每条规则都带动作**与范围**）、`iterate`（把决定写入台账）、`outcome`（关联后续读数，回报这次调整是否真的有效）、`rules`（打印当前生效的阈值）。 |
| `novel_status` | 全流程 | 看板，全部由项目状态派生，不需要维护第二张表：`dashboard`（默认）、`bible`、`plan`、`chapter`。 |
| `novel_repo` | 六 复盘 | 收尾阶段：`export`（Markdown 成稿）、`retro`、`asset`、`lesson`、`template`。 |
| `novel_review` | 五/六 判断 | **唯一由模型驱动的工具。** `ai-flavor` 按版本化的去 AI 化 rubric 诊断单章（加 `rewrite=true` 会额外产出改写稿，但只落成旁挂文件，绝不写进章节）；`opening` 用 SOP 开篇清单体检门禁章；`competitor` 把粘进来的竞品原文拆成 `novel_plan` 能接收的结构；`retro` 读项目自己的数据，提出可复用与要避开的经验。每次调用都记录 provider、model 与提示词版本，并把完整对话写到 `.novel/reviews/`。**模型写的内容除非你显式 `save=true`，不会进台账。** |

**一个 `novelState` 服务**——所有工具与界面共用的、带冲突检查的唯一写入通道，按会话解析。

**一个 Web 界面标签页**——右侧栏中的「Novel Composer」，可从侧栏引导页打开。

## 这套工具实现的 SOP

工作流本体是 [`docs/sop.md`](docs/sop.md)（爆款网文创作全流程 SOP 3.1），闭环为
**假设 → 验证 → 放大 → 复盘 → 复用**：先用竞品拆解与唯一记忆点立假设，用最小可行大纲和开篇包
小成本验证，通过后才搭完整骨架，连载中用带基线的指标滚动迭代，完本后沉淀成可复用的结构。

插件的价值在于让这套 SOP **可执行**，而不是停在建议层面：

- 每一步的产出都是项目文档里的字段，「该记的记了」，不会只活在正文里；
- 阈值由校准中位算出，而不是心算——`novel_init` 录中位，`novel_verify` 与 `novel_metrics`
  套用倍数；
- 阶段由数据派生，所以工具任何时候都在汇报项目真实所处的位置，以及下一阶段还缺什么；
- SOP 认为你还没到那一步时，调用**依然成功**，只是在返回值里带上 `warnings` 说明缺什么。这道
  软拦从不拒绝调用。唯一的例外是**没通过的验证轮**：必须写明回退目标与放弃条件，否则这一轮会被
  拒绝——不写这两项的验证记录本身就是无效记录。

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
dsh plugin --profile web add -w "$(pwd)/packages/ai-webnovel-composer"
```

`-w` 不能省。`dsh plugin` 把 `add` 之后的参数原样转发给在 profile 目录里运行的 pnpm，而那个
目录本身就是一个 pnpm workspace 根（`pnpm-workspace.yaml` 就在它的 `package.json` 旁边），
所以 pnpm 只接受带 `--workspace-root` 的依赖写入。

随后 `dsh plugin add` 会对齐 `dsh.profile.bundles`：由于 `@ai-webnovel/composer` 声明了
`dsh.bundle.patch`，它会自动加入该 profile 的层叠栈。重启 `dsh web` 后，新会话即可看到八个
计算型工具，有可用模型时 `novel_review` 一并出现，侧栏引导页出现创作台标签页。

结尾这个 spec 是**包名而不是命令名**——`dsh plugin` 把它之后的参数原样转发给 pnpm，所以它
必须是 pnpm 能解析的包名。`@ai-webnovel/composer` 是 *bundle*（npm scope 为
`@ai-webnovel`、包名为 `composer`）；它拉进来的 *插件* 是 `@ai-webnovel/composer-host`，
加载时的行 id 为 `ai-webnovel-composer`。

不启动会话也能确认组合结果：

```sh
dsh --profile web --dump-config | grep -A2 ai-webnovel
```

卸载：

```sh
dsh plugin --profile web remove -w @ai-webnovel/composer
```

> **正在改这个插件？** 改完源码执行 `pnpm run build`（或
> `pnpm --filter @ai-webnovel/composer-host run build --watch`）。profile 链接的是本仓库，
> host 半边重新构建即可生效；浏览器半边由 `packages/ai-webnovel-composer-host/lib/client.js` 提供，
> 需要刷新页面。profile 加载的是 `lib/`，所以没重新构建前，跑着的 `dsh web` 还是上一版工具。

## 目录结构

```
packages/
  ai-webnovel-composer/         # BUNDLE  @ai-webnovel/composer
    cordis.patch.yml            #   把插件行插入 profile 插件树
  ai-webnovel-composer-host/    # PLUGIN  @ai-webnovel/composer-host
    src/core/                   #   纯领域逻辑：类型、状态、细纲校验、指标规则、
                                #   兑现回报、复盘组装、工作区判定
    src/host/                   #   ctx.fs 存储、按会话解析、提示词片段、工具注册
    src/client/                 #   Web 界面标签页（右侧栏），构建为 lib/client.js
    src/index.ts                #   Cordis 插件本体（name / inject / Config / apply）
```

目录名与包名一一对应：插件是 `@ai-webnovel/composer-host`，所以放在
`packages/ai-webnovel-composer-host`；bundle 是 `@ai-webnovel/composer`，所以放在
`packages/ai-webnovel-composer`。

之所以拆成两个包：bundle 的 patch 只能「插入一行、行里写着插件包名」，而一个包无法为
自己插入一行。

host 包另有一份开发者参考
[`packages/ai-webnovel-composer-host/README.md`](packages/ai-webnovel-composer-host/README.md)：
模块地图、schema v2 数据模型，以及贡献者不能破坏的几条不变量。

## 小说存放在哪里

唯一事实来源是一份 JSON 文档：`<工作区>/.novel/novel.json`。立意、商业框架、人物、世界设定、
承诺、大纲、每一章、指标读数与迭代台账同进同出，因此任何一次写入都不会让项目自相矛盾。它刻意
保持为纯 JSON——你可以直接读、放进 git 做 diff、手工修改，`novel_status` 会如实反映结果。

```
novel-workspace/
  .novel/
    novel.json             # 项目本体（schemaVersion: 2）
    manuscript.md          # 由 novel_repo operation="export" 写出
    templates/             # 由 novel_repo operation="template" 写出
```

文档版本是 `schemaVersion: 2`。读到 v1 文档时会自动迁移，且**绝不丢稿**：旧的章节 `synopsis`
成为该章的剧情任务，旧的立意、人物、世界设定与章节全部保留，SOP 需要而 v1 没有建模的记录从空
开始（于是项目自然落在它数据所支持的阶段）。无法识别的版本会被拒绝，而不是猜着读。

### 一个目录怎么才算「网文工作区」

DSH 里的 **workspace** 是宿主登记的一个目录；**session** 记录自己运行在哪个目录（`cwd`）。
插件按 **session 的 workspace** 解析项目，**绝不**按服务器启动时所在的目录——所以一个
`dsh web` 服务可以承载多部小说各自的会话，互不干扰。

插件对每个 session 的工作区做一次判定，并据此行事：

| 发现 | 判定 | 结果 |
|---|---|---|
| `.novel/novel.json`（项目文档） | `novel` | 原样采用，**永不改写**。工具与提示词立即生效。 |
| 只有 `.novel/` 目录、还没有文档 | `novel` | 视为网文工作区，文档留给 `novel_init` 去写。 |
| 三个以上章节形态的文件（`001-*.md`、`第3章.md`） | `novel` | 识别为已有草稿，在旁边补建项目文档。 |
| 空目录 | `fresh` | **不碰**。让 agent 在这里开一本（或配 `adoptEmptyWorkspace: true`）。 |
| 代码仓库（`package.json`、`.git` 等） | `plain` | 不碰。工具保持静默，提示词里也会说明。 |
| 其他 | `plain` | 不碰。 |

`novel` 工作区还会在**每一步的 system prompt 里注入一段运行时上下文**，说明工作区类型并汇报
当前进度（章节数、字数、未写章节数、设定集规模）。因此打开一本小说不需要任何「发现」回合。

### 一个对话写一部小说

这里没有「切换项目」的工具，因为项目跟着会话走：在界面上打开另一个 workspace，工具就自动解析到
它的根目录。会话没有记录 `cwd` 时，才回退到配置的 `workspaceRoot`，最后才是进程目录。
`novel_status` 汇报的是**当前调用会话**所在工作区的判定，那是关于「我正在改哪一本」的权威答案。

判定刻意保守：带几个 Markdown 的代码仓库**不算**草稿，只认章节形态文件名，而且**不会**往空目录里
写任何东西，除非你明确要求。若想无视探测、固定某个目录：

```yaml
# 你的 profile 的 cordis.patch.yml
- id: ai-webnovel-composer
  config:
    workspaceRoot: /Users/me/novels/qingyun   # session 未记录 cwd 时的回退
    workspaceMode: auto                       # auto（默认）| novel | off
    adoptEmptyWorkspace: false                # true：启动时就在空目录里建好项目
    reviewProvider: ''                        # 留空：评审跟随当前会话的模型
    reviewModel: ''                           # 两项都填：把 novel_review 固定到某个模型
    reviewTimeoutMs: 120000                   # 单次评审的超时上限
```

`novel_review` 是唯一需要模型的工具，路由按此顺序解析：调用参数里的 `provider`/`model`
→ 配置的 `reviewProvider`/`reviewModel` → 当前会话正在用的模型。三者都没有时它**不注册**，
于是一个没有模型的环境仍然是八个可用工具，而不是九个坏工具。

`off` 在启动时什么都不写——工具仍然注册，用户明确要求时 `novel_init` 依旧可用。

## 打包分发

`pnpm run dist` 会先构建、再在 `dist/` 下产出两个分发包，两者携带**同一套九个工具**——工具代码
一律从本仓库构建产物复制，不重写。

### 一、DSH plugin 分发包 —— `dist/dsh-plugin/ai-webnovel-composer-<版本>.tgz`

**一个 tarball，一个包。** `@ai-webnovel/composer` 同时是 bundle、plugin 与浏览器半边：

- 它声明了 `dsh.bundle.patch`，这正是 DSH 把它追加进 `dsh.profile.bundles` 的依据；
- 它的根导出（以及 `./host` 别名）就是注册九个工具的那个模块；
- 它的 `./client` 导出是 Web 界面半边，以 `window.__ModuleLoader__` 形式提供。

```sh
pnpm run dist
dsh plugin --profile web add -w dist/dsh-plugin/ai-webnovel-composer-0.1.0.tgz
```

tarball 里带着构建好的 `lib/`，所以目标机器只需要 Node 和 DSH——不用连仓库、不用联网安装、
也不用现场构建。

> **它满足的两条约束都是实测换来的。** 第一，patch 的行名必须是**裸包名**：客户端扫描器用
> "精确包名"规则推导包根，行名写成 `@ai-webnovel/composer/host` 虽然能解析插件，却会让浏览器
> 半边**静默地**不进启动清单。第二，分发包必须是**一个**包：pnpm 的 tarball 安装只认压缩包内的
> 一个包——嵌套的 `file:./sub` 报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`，而并列两个包
> （`file:../sibling`）实测只解出其中一个。源码仓库保留两个包，因为它们由不同工具构建、面向不同
> 目标；只有分发时合并，并且打包步骤会重建浏览器半边，让它的注册 id 与出厂的包名一致。

### 二、SKILL 标准分发包 —— `dist/skill/ai-webnovel-composer/`

一个可移植的 Agent Skill 目录包：`SKILL.md` 带 DSH 文件系统 provider 会解析的 frontmatter 与
**全部九个工具的清单表**，`references/` 放工作流、工具参考与由代码生成的阈值，`scripts/` 放安装
脚本，`tools/` 放与分发包一相同的那个包。

```sh
node dist/skill/ai-webnovel-composer/scripts/setup.mjs --profile web
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
pnpm test             # vitest：SOP 全流程端到端，外加存储、工作区、提示词
                      # 与浏览器产物的用例
```

[`docs/sop.md`](docs/sop.md) 是工具所实现的工作流本体——阶段、字段与阈值的权威清单。
动手改之前请先读 [`docs/architecture.md`](docs/architecture.md)：它讲了这个插件是怎么搭起来的、
以及为什么这么搭。

## 许可证

MIT
