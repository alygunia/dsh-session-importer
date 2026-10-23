# dsh-session-importer

[English](README.md) | 中文

在 dsh web 界面里把导出的会话日志 ZIP 导回 DeepSeek Harness（DSH）。会话、它的子会话日志以及被引用的附件都通过常规的 Session 服务重建，因此导入的会话与原生创建的会话没有区别——它会出现在侧边栏，并且像其他会话一样打开、分页、续跑。

归档格式就是 `@deepseek-ai/dsh-session-log-export` 产出的那一种（会话标题栏「更多操作」里的 **Download session log**，或 `/export` 命令）：`dsh-session-<id>.zip`。由*旧版* DSH 导出的归档会在导入时迁移到已装的会话格式，所以一次下载在升级之后依然可用。

插件跟随已部署的 harness，而不是钉死某个版本：主机半边只用长期稳定的 Session 服务契约，浏览器半边使用当前 primitives 的图标名。它需要安装提供的那两样东西都是「用不到就降级并报告」，而不是假定存在——会话格式库（凡挂载了 JSONL persistence 后端的地方都有）与会话列表上的 `retainedBy.mainView`，后者正是 shell 自己用来判定「哪个会话是打开着的」的依据。见 `format.migrationUnavailable` 与对话框里工作区的回退说明。

### 兼容性

在 `@deepseek-ai/dsh` **0.2.1-rc.2**（会话格式第 4 代）上验证通过。

| DSH | 状态 |
|---|---|
| 0.2.1-rc.2 | 已验证——当前目标版本 |
| 0.2.0-rc.2 | 此前已验证；浏览器半边改为通过 `uiWorkspace.openSession()` 打开导入的会话，这两个版本都提供该接口 |

两个版本之间上游动过的细节都已处理：会话列表快照不再带 `current` 字段（打开着的会话改从 `retainedBy.mainView` 读），图标也去掉了旧的按尺寸命名的别名。对话框里的 **打开会话** 按钮现在请工作区 façade 把导入的会话显示出来——DSH 0.2.x 的 `ISessions` 上并没有 `open()`，所以先前那道 `typeof service.open === 'function'` 的守卫其实什么也没做。

## 安装

```sh
dsh plugin --profile web add E:/Project/dsh-ext/dsh-session-importer
```

该命令把包装进 profile 并激活它的 bundle 层。如果 profile 还没有链接这个目录，请使用绝对路径，或者手工加一行 patch：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: session-importer
      name: 'E:/Project/dsh-ext/dsh-session-importer/src/index.js'
```

然后 **重启 `dsh web`**——新插件在启动时从 profile 加载，浏览器也需要新的客户端 bundle。可用 `dsh --profile web --dump-config` 确认那一行已经出现。

## 使用

两个入口打开同一个对话框：

| 位置 | 内容 |
|---|---|
| 会话标题栏 → 更多操作菜单 | **导入会话**，紧跟在 **下载 Session 日志** 下面 |
| 侧边栏底部 | **导入会话**（始终可用；栏折叠时收成一个图标） |

标题栏那个入口就在 session-log 导出插件自己的菜单里，所以「导出/导入」读起来是一对动作。那个菜单用字面量 items 数组渲染，因此这一项是**注入到已渲染的菜单 DOM** 里的（见[标题栏菜单项](#标题栏菜单项)）；侧边栏那个入口不需要这种配合，在任何组装下都在。

DSH 0.2.1 确实提供了一个面向会话标题栏条目的正式槽位 `conversation.session.header.utilities`，导出插件自己也注册了进去。但注册进去的条目会渲染成标题栏里**独立的一格**，而不是「更多操作」菜单里的一项，所以它替代不了这个菜单项——要「紧挨着下载动作」，仍然只能靠下面说的注入。

对话框里：

1. 把 `dsh-session-<id>.zip` 拖到投放区，或点击它选择文件。若部署把归档留在服务器上，也可以直接填绝对主机路径。
2. 选择会话归属：保持归档里的工作区（该目录存在时的默认值）、归入当前会话的工作区，或显式指定路径。
3. **导入**。对话框会报告写了什么——会话数、附件数、工作区分组——随后提供 **打开会话**。

导入成功后客户端会请求主机重新读取会话列表，因此会话立即出现在侧边栏，不需要再刷新别的东西。

### 标题栏菜单项

`@deepseek-ai/dsh-session-log-export` 用字面量 `items` 数组渲染会话标题栏的「更多操作」菜单，导入项于是改成在该菜单打开时注入其 DOM：

- 注入节点是**下载项的克隆**，所以无需知道任何哈希类名，就能继承原生菜单项的 class、hover 效果与不依赖语言的排版；
- 菜单的键盘导航实时遍历 `button:not(:disabled)`，注入的按钮因此自动进入键盘模型；
- 菜单每次打开都会重建，没有需要长期同步的东西——注入由菜单自身的插入驱动，而不是挂一个全 body 的 observer，所以会话流式输出不产生开销；认不出下载项的菜单一律不碰；
- observer 与所有注入节点都归属插件 fiber，卸载时一并移除。

这份耦合是写明的而不是藏起来的，因为它是「紧挨着下载动作」而不是「并排在旁边」的唯一办法：将来的 DSH 版本若改了那个菜单的结构，这一项会静静地不再出现，而侧边栏入口照常工作。`scripts/verify-e2e.ps1` 会对真实渲染出的菜单做断言，断言失败时用 `-ProbeUi` 打印页面实际渲染出的结构。

## 导入会写入什么

| 归档条目 | 导入为 |
|---|---|
| `session[.vN].jsonl` | 根会话（就是侧边栏里显示的那一行） |
| `subagents/<id>/session[.vN].jsonl` | 每个子会话一个会话，保留其谱系 |
| `media/<attachmentId>.<ext>` | 恢复进附件存储的图片 |
| `files/<xx>/<digest>/<name>` | 恢复进附件存储的原样文件 |

日志是通过 `ctx.sessionPersistence.create()` / `handle.append()` / `handle.flush()` 写入的，而不是自己写文件：zstd 帧、校验和布局、单射的 id 转义、项目目录命名都归 persistence provider 所有，因此导入对任何已挂载的后端都成立，而不只是 JSONL 那一个。

归档带着它**导出时的格式世代**，而 DSH 只会写出它自己实现的那一代。因此来自旧版 DSH 的归档会先交给该安装自带的格式库做迁移，再写入任何内容——用的就是 DSH 读取旧日志的同一份代码，这里既不重新实现也不猜测。迁移不等于改个版本号：旧边要把工具结果提升成当前的角色、重命名消息来源、补齐有据可循的中断回合，并为父会话补上缺失的子会话目录事实。计划、响应和对话框都会报告归档世代、已装世代，以及是否发生了迁移。

### 保证

- **保留身份。** 归档内部的会话 id 互相引用（子会话的 header 写着父 id，工具结果里带着子会话 id），所以 id 按原样重建；关系树内部保持自洽，导入会话里的子会话视图可用。
- **只向后迁移，不向前猜。** 早于已装世代的归档先由已装格式库翻译；来自*更新*版 DSH 的归档会被带上两个版本号拒绝，而不是当成这个构建会误读的东西导进来。
- **从不破坏性写入。** 已存在的会话 id 一律*跳过*，绝不覆盖。重复导入是报告 `alreadyImported: true` 的无操作；只完成了一部分的导入可以靠再次导入同一个归档补齐——缺的被写进去，已有的被跳过。
- **先校验，不通过就回滚。** 写完之后每个导入的日志都会通过 persistence 读取路径回读一遍，harness 正是在那里校验事件词表与重放不变量。这个构建无法解释的日志（比如来自更新版 harness 的归档）会响亮失败，其文件随即被删除，因此坏会话不会落进侧边栏。
- **分组是尽力而为，但失败会说明原因。** 根会话通过 `ctx.workspaceRegistry` 归入其工作区。如果工作区记录写不进去，或归档里的 cwd 在本机已不存在，会话照样导入并可见——只是归到「未分组」，对话框里会写出原因。写完成员表之后会回读一次，「注册表默默丢弃了这条记账」因此不会伪装成成功。
- **被永久删除过的 id 可以再次导入并重新归组。** 有的插件（例如 `@michengai/dsh-archive-manager`）会为它删除过的 id 留下「墓碑」，让注册表的 header 索引拒绝重新索引该 id——否则一份陈旧的 `list()` 会把刚删掉的日志又编回索引。而「先删除该会话，再选当前工作区重新导入」正是本插件对话框自己给的做法，所以导入写的正是一个复用的 id：插件在归组前会请求该部署提供的遗忘钩子（`clearTombstone`，存在才调用），把过期的墓碑清掉。

### *不会*恢复的内容

- **投影缓存行**（标题、token 计数、派生摘要）。这些只是展示提示，会从日志自愈；它们都不决定列表成员资格。
- **工作区显示顺序与归档标记。** 导入不会重排侧边栏，导入的 id 也绝不会被加进已归档集合。
- **活的 agent 状态。** 不会恢复任何运行态：在你打开它并发出消息之前，它只是一段持久化历史。

## 配置

所有字段都是可选的；下面的默认值来自插件的 `Config` schema。设置了 `config` 的 patch 行必须把它要的每个键都重述一遍（patch 是整体替换 config，不是合并）。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxUploadBytes` | `268435456`（256 MiB） | 接受的最大请求体，同时也是主机路径归档的大小上限 |
| `maxExtractedBytes` | `1073741824`（1 GiB） | 解压后总大小上限，防御解压炸弹 |
| `allowHostPath` | `true` | 是否接受来自主机文件系统的 `?path=` / `{"path": …}` 导入 |
| `workspace` | `'auto'` | 默认目标工作区策略：`auto`、`original` 或 `current` |
| `verifyRead` | `true` | 报告成功之前回读每一个导入的日志 |
| `sessionsRoot` | `''` | 仅用于回滚清理的会话日志根目录；为空时解析为 `$DSH_HOME/sessions` |

```yaml
- id: session-importer
  config:
    maxUploadBytes: 67108864
    maxExtractedBytes: 268435456
    allowHostPath: false
    workspace: current
    verifyRead: true
    sessionsRoot: ''
```

## HTTP 契约

主机路由是共享 API 通道上的一条 exact Fetch 路由，因此浏览器会话 cookie 照常生效，部署提供的 `/api` 策略也会被遵守。

**`GET /api/session.import`** —— 能力探测；返回生效的限制、本部署写出的会话格式世代（`format.installedVersion`）与用法说明，不需要请求体。

**`POST /api/session.import`** —— 导入。查询参数：

| 参数 | 含义 |
|---|---|
| *（原始请求体）* | ZIP 字节；对话框走的就是这条 |
| `path` | 归档的绝对主机路径，替代请求体 |
| `workspace` | `auto` \| `original` \| `current` |
| `cwd` | 覆盖 `workspace` 的绝对路径 |
| `sessionId` | 发起导入的会话，用于解析 `workspace=current` |
| `dryRun=true` | 只解析并给出计划，不写任何东西 |

`Content-Type: application/json` 加 `{"path": …}` 可作为 `?path=` 的替代。JSON 响应描述计划、导入了什么、跳过了什么、会话是否通过校验、恢复了多少附件、工作区结果，以及全部错误与警告。非法归档返回 `400`；导入失败返回 `500`，并带上逐个会话的错误。

每个响应与计划都带一个 `format` 块：

| 字段 | 含义 |
|---|---|
| `archivedVersion` | 归档日志里的格式世代 |
| `installedVersion` | 本部署写出的世代（未知时为 `null`） |
| `migrationRequired` | 导入是否会翻译这些日志（仅计划里有） |
| `migratedSessions` | 实际翻译了多少个日志（仅导入响应里有） |
| `migrationUnavailable` | 无法判定世代时的原因 |

```sh
# 只看不导
curl -X POST 'http://127.0.0.1:8080/api/session.import?path=E:/backup/dsh-session-x.zip&dryRun=true'
# 导入
curl -X POST --data-binary @dsh-session-x.zip -H 'content-type: application/zip' \
     'http://127.0.0.1:8080/api/session.import?workspace=current'
```

在运行中的 web GUI 里，这些调用需要浏览器会话 cookie；请在页面里（或直接通过对话框）发起，而不是在裸 shell 里。

## 模型工具

插件同时注册了 `import_session_archive`（`path`，可选 `dry_run`，可选 `cwd`），因此 agent 可以导入它在主机文件系统上看得见的归档，并汇报改动了什么。模型调用没有对话框可以选工作区，所以**发起调用的那个会话就是导入者**：不传 `cwd` 时，归组规则与对话框完全一致——归档里的工作区在本机仍存在就用它，否则用发起会话自己的工作区；主机启动目录只是最后兜底，dry run 会说明用的是哪一条。

## 限制

- **一个请求一次导入。** 对话框会把双击合并掉，但不同归档的并发导入是彼此独立的请求。
- **浏览器路径会把归档整个缓冲。** 上传走 buffered Fetch 路由（部署整体上限 300 MiB）；插件自己的 `maxUploadBytes` 是更紧的那道限制。归档很大时请改用主机路径而不是上传。
- **cwd 必须存在。** 工作区分组需要归档里的目录真实存在，注册表才能把它规范化；解析到别处的 cwd 会归入「未分组」，而不是被搬走。
- **种子切点重建。** fork 出来的种子日志（`isSeeded: true`）会用其 inherited `session/end-seed` 标记推导出的继承前缀来恢复。丢失该标记的归档会被拒绝，而不是拿一个猜出来的切点导入。
- **比本部署更新的归档会被拒绝。** 迁移只向后做；来自*更新*版 DSH 的日志会被带上两个版本号拒绝，而不是当成这个构建会误读的东西写进去。[格式探针](#开发)可以在不起实例的情况下看清某个安装会对旧日志做什么。
- **回滚是文件系统级别的。** 校验失败的回滚会删除它的日志目录；如果删除本身也失败了，进程内的会话注册表可能要到下次重启才不再列出该 id（发生这种情况时响应里会说明）。
- **已存在的会话无法在工作区之间移动。** 会话属于「日志 header 里记录的 cwd」对应的那个工作区，而 header 一旦写入就不可改写（日志是 append-only）。所以无论你选哪个工作区，重复导入都不会把已有会话搬家——要换工作区，请先删除该会话再导入。对话框现在会直接说明这一点，而不是报一个「什么都没有发生」。
- **删除类插件会改变「重新导入」的前提。** 本插件的「重新归组」路线假设删除之后这个 id 就是干净的；若某个插件删完会话还留着墓碑，插件会尽力清掉它（见[保证](#保证)）。只有在注册表根本不提供该钩子、或它换用别的机制时，归组才会失败——这时对话框会给出注册表的原话，而不是一个没有解释的「未分组」。
- **「当前工作区」指的是你打开的那个会话。** 浏览器会把选中的会话 id 发过来，主机读取它存储的 cwd。没有打开任何会话时无从解析，主机会退回到自己的工作目录——响应与对话框都会报出这个回退，因为那个目录决定分组。
- **标题栏菜单项依赖另一个插件的结构。** 它是注入进 session-log 导出插件的菜单的（见[标题栏菜单项](#标题栏菜单项)），所以某个版本改了那份结构，这一项就会消失——安静地消失，且不影响侧边栏入口。没有装那个插件的组装则根本不会有这一项。

## 开发

没有构建步骤：`src/index.js` 是主机半边，`src/client.js` 是以经典 `window.__ModuleLoader__.load` 形式加载的浏览器半边，`src/format.js` 是唯一会导入 Node 内置模块以外东西的部分（它按解析出的路径加载运行中安装的会话格式库——先取 catalog，再从 *catalog 自己的作用域* 里取历史版本边包，因为 pnpm 安装会把它们嵌套在 catalog 下），`src/zip.js` 里那约 150 行的中央目录解析器是刻意的，这样包在 profile 里不需要安装任何依赖。

```sh
npm test                      # 语法检查 + 归档冒烟测试
npm test -- path/to/archive.zip   # ……改用指定归档
npm run verify:e2e            # 对一次性 DSH 实例跑 28 项检查（PowerShell 7）
node test/smoke.mjs path/to/other.zip
node test/format-probe.mjs path/to/archive.zip   # 看本 DSH 会对旧日志做什么
```

冒烟测试与 E2E 都需要一份真实导出的归档，它属于用户数据而不是签入的夹具：用参数传入、设 `DSH_TEST_ARCHIVE`，或把 `dsh-session-*.zip` 放在 `package.json` 旁边。

`test/smoke.mjs` 拿真实导出归档检验 ZIP 读取器与导入计划器：条目分类、header 采纳、逐会话连续事件的计划、id 保留、cwd 盖章、附件重映射，以及计划器的拒绝路径（没有根日志、header 含未知字段、日志 seq 不连续、种子日志缺标记）。它不需要 DSH 实例。

`test/format-probe.mjs` 直接用绝对路径驱动已装的会话格式库处理一份归档（裸 `node` 进程没有装载器的解析能力）。它会打印每个日志的源世代、迁移后的世代、事件数增减、seq 是否致密，以及能观察到的变换（工具结果角色、父会话目录事实），是查明一次 DSH 升级会怎样处理既有归档的最快方式。

`scripts/verify-e2e.ps1` 会起一个一次性 `dsh web`，先用 HTTP 把整条链路驱动一遍，然后（在装有 Chromium 系浏览器时）通过 DevTools 协议无头驱动真实 GUI。它断言的是结果而不是日志，因为这个插件的浏览器半边没有别的检查方式：

| 分组 | 检查内容 |
|---|---|
| Composition | overlay 只留下一行插件行并指向本 checkout |
| 插件两半 | bundle 出现在 `__DSH_BOOT__` 中、被服务的 bundle 就是本包的客户端半边、fiber 为 `active`、路由能应答带本部署会话格式的探针 |
| 导入计划 | 干跑能规划全部日志且不写入、条目计数自洽、根会话保留其 id、归档世代与已装世代做了比较 |
| 导入 | 每个会话都写入、报告的迁移数量与计划一致、每个日志都被读取器回读、附件已恢复、根会话归入其工作区 |
| 可见性 | `session/list` 带出这些会话且 cwd 正确，`session/page` 能加载根会话与一个子会话 |
| 幂等 | 重复导入不写入任何东西并报告 `alreadyImported`，被删掉的子会话能靠再导入补齐 |
| 工作区选择 | `workspace=current` 按指定会话解析、解析不到时报出实际回退到的目录、重复导入时换了选择也会说明已存在的会话无法移动 |
| 拒绝 | 当前世代的归档上传导入且不做迁移、非 ZIP 返回 400、未知事件词表被拒绝并回滚且不留残留 |
| 浏览器（无头） | 客户端半边在真实浏览器里启动、**被导入会话自己的那一行**被打开（按会话 id 选中，而不是按标题猜）、其「更多操作」菜单中 **导入会话** 紧跟在 **下载 Session 日志** 之后、点击这一项能打开导入对话框，且对话框的输入框与它的 3 个策略选项在**部署自身的皮肤与材质下**保持可读且完整显示（对触发器与每个选项按合成背景计算对比度、无文字被截断、列表不超出视口） |

```sh
pwsh -NoProfile -File scripts/verify-e2e.ps1                 # 用 repo 根目录里的示例归档
pwsh -NoProfile -File scripts/verify-e2e.ps1 -Archive x.zip  # 指定归档（或设 DSH_TEST_ARCHIVE）
pwsh -NoProfile -File scripts/verify-e2e.ps1 -SkipUi         # 只跑 HTTP 部分，不起浏览器
pwsh -NoProfile -File scripts/verify-e2e.ps1 -ProbeUi        # 打印渲染出的结构而不做断言
pwsh -NoProfile -File scripts/verify-e2e.ps1 -Archive x.zip -KeepScratch
```

它用目标 profile 的一份副本加 `node_modules` 链接搭出临时实例（启动 profile 不会跑包安装，所以既不需要网络也不会装任何东西），以绝对源码路径挂载插件——当该包已经装进 profile 时**改写成 patch 而非 insert**，否则会因为重复 id 直接启动失败——并在系统分配的端口上启动。它还会把部署的主题状态（`dream-skin.json`、`settings.yaml`；用 `-ThemeHome` 指向别处）复制进临时 home，因此浏览器那一段渲染的就是用户实际拥有的皮肤、材质与壁纸。真实 DSH home 不会被写入；跑完会停掉两个进程、删除临时目录，并复查真实 profile 的安装仍然在。

浏览器那一段（`scripts/verify-ui.mjs`）会走真实的首启流程——关掉内测声明、选中拥有导入会话的工作区、按 `data-row-key` 打开本次运行导入的那个会话——并把两个被断言状态的截图写到 `docs/evidence/`。它不需要任何依赖：DevTools 协议跑在 Node 的全局 `WebSocket` 上。改这段流程前有两点值得先知道：首启选工作区会开出一个*空白草稿*，而它的侧边栏行与「还没有标题投影的导入会话」在标签上一模一样，所以那一行是按会话 id 而不是按标题定位的；页面合法地可以同时存在多个菜单，因此对话框的策略列表只认「触发器这一击新开出来的那个」，绝不认「第一个条目够多的菜单」（会话行的右键菜单有 5 项）。

两个脚本都仅支持 PowerShell 7（用到 junction/symlink、`-SkipHttpErrorCheck`），Windows、Linux、macOS 均可运行。它们绕开了三个环境行为，三者在受限的 Windows 策略下都属正常：`taskkill /T` 与 `Get-NetTCPConnection` 都可能被拒绝，因此子进程清理回落到 `netstat -ano` 加 `Stop-Process`；「先杀掉直接子进程」是脚本能返回的前提（PowerShell 会一直 drain 被 spawn 进程的 redirect 流，直到那个子进程的句柄关闭）；而屏蔽命名管道的沙箱会让 Chromium 根本起不来，那种环境下浏览器那一段无法运行（用 `-SkipUi` 明确跳过）。

`notes/dsh-session-list-state.md` 记录了这个设计所依赖的会话列表调查结论（成员资格来自 persistence 的目录扫描；`workspace` 记账只决定分组；冷会话的新行不会被任何事件推送到前端）。
