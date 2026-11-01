# dsh-token-split

给 **DSH** 用的本机 OpenCode Go 记账插件：只统计 `opencode-go` 这一条来源的用量，按 Go 官方价目表（含 DeepSeek 峰谷价）算出美元金额，在侧边栏显示金额与**额度百分比**，并把包月订阅费按金额比例分摊到人头。

> 场景：你和朋友共享一个 `opencode go` 订阅（同一个 key），两台机器各装各的 DSH。插件只统计**本机**、只统计**这个 provider** 的用量，朋友那台机器跑同一个插件，两边报出各自的金额，就能算出谁该出多少。

版本 **0.3.0** · 2026-11-01 · MIT

## 它做什么

1. **只记 opencode-go**：每条记录带 provider，报告和面板默认只算 `providers: ['opencode-go']`。你自己用 deepseek 官方 key、qianfan 等其它来源的消耗一律不进账。
2. **实时记账 + 历史补录**：订阅 `session/event` 折叠每条 `assistant/message.usage`；启动时扫一遍磁盘上的会话日志补录历史。补录幂等，重启不重复。
3. **按 Go 价目表计价**：`lib/pricing.js` 内置 30 个模型单价（USD / 1M tokens，其中 2 个免费档），DeepSeek V4.1 Flash 与 V4 Pro 自动区分峰谷时段。
4. **额度百分比**：每个模型显示「金额 / 额度占用」（`$0.446 / 0.45%`，即 `cost / 该模型月额度`）；面板顶部总金额旁是**总百分比**，按共享池口径 `Σ(cost / limit)` 计算。
5. **侧边栏面板**：侧边栏底部一个金额 chip（本自然月），点开是「本自然月金额 / 按模型 / 滚动窗口小字」，数据来自宿主只读路由 `GET /token-split/summary`。
6. **详细用量弹层**：面板右上角 `⋯` 打开，总用量一块 + 每个模型一块，每块**独立**的 `日 / 月 / 会话` 三种模式与时间翻页，手写 SVG 折线 / 柱状图。数据来自 `GET /token-split/timeline`。
7. **工具与导出**：`token_usage` 工具出 Markdown 报告；`save: true` 额外写 `.md` 和逐步 `.csv`。

## 安装

**从 GitHub 装（推荐，朋友也是这条命令）：**

```powershell
dsh plugin --profile desktop add github:<你的用户名>/dsh-token-counter
```

> 本仓库自带的 `package.json` 里 `repository` 指向 `github.com/UserJCY/dsh-token-counter`。如果你推到自己的 fork，请把上面命令和 `package.json` 里的仓库地址一起换成本人 fork。

**从本地目录 / 离线包装（改代码或内网分发时用）：**

```powershell
dsh plugin --profile desktop add file:<本仓库或解包目录的绝对路径>
```

`dsh plugin add` 会自己把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`。然后**重启 DSH**。

重启后：`~/.dsh/token-split/ledger.json` 出现，历史补录在后台跑完，侧边栏底部出现金额 chip。

### 更新

git 依赖按 commit 拉取，`file:` 依赖是拷贝，两种都要重装才会生效：

```powershell
dsh plugin --profile desktop remove dsh-token-split
dsh plugin --profile desktop add github:<你的用户名>/dsh-token-counter
```

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-token-split
```

账本不会被删除，留着对账。

## 配置

默认值全在 schema 里，`cordis.patch.yml` 只写要改的字段：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: token-split
  config:
    user: alice
    monthlyFee: 10        # Go 是 $10/月，Go Plus $40，Go Teams $20/人
    cycleStartDay: 1
    providers: [opencode-go]
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `user` | 系统账户名 | 写进每条记录的归属名。 |
| `providers` | `['opencode-go']` | **只统计这些 provider 路由**。空数组 = 不过滤（会把别的来源也算进来）。 |
| `plan` | `go` | `go` / `plus` / `teams`，只用于文案。 |
| `monthlyFee` | `10` | 每周期订阅总价（美元）。 |
| `cycleStartDay` | `1` | 周期起点（1–28）。只影响 `period: 'cycle'` 与折算口径，面板固定看**本自然月**。 |
| `fxRate` | `0` | 美元兑人民币汇率；> 0 时报告和面板额外给人民币参考。 |
| `pricingFile` | `''` | 额外的价目覆盖文件；留空只读数据目录下的 `pricing.json`。 |
| `includeSubagents` | `true` | 子代理会话是否计入本机（统计时子会话金额并入根会话，会话数按根会话计）。 |
| `backfill` | `true` | 启动时补录历史。 |
| `reportDir` | `''` | `save` 落盘目录；空 = 当前会话工作目录。 |

## 侧边栏面板

侧边栏底部（`sidebar.footer.action`，order 5）一个 chip，显示**本自然月**的金额。点开：

```
┌──────────────────────────────────┐
│ 2026-11-01 ~ 2026-11-30 · alice  ⟳ ⋯│
│ $0.446                      0.45% │
│ 37,294,551 tokens · 189 次调用 · 3 个会话 │
│                                  │
│ 按模型                            │
│ DeepSeek V4.1 Flash  $0.446 / 0.45%│
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁          │
│                                  │
│ 本机口径 · 仅 opencode-go · 本自然月 │
│ 5h 0.02%/20% · 周 0.09%/50%       │
│ 另有 4 个模型本月未使用             │
└──────────────────────────────────┘
```

- 顶部大数字是本自然月金额，右边是**总百分比**（`Σ(cost/limit)`，共享池口径）。只要有付费模型缺额度数据，百分比就显示 `—`，因为那种求和不可信。
- 每行模型是「金额 / 该模型额度占用」，下面是该模型占本月金额比例的细条；未定价模型变淡并提示，免费档显示 `/ 免费`。
- 底部小字是 `5h x%/20% · 周 y%/50%`：滚动 5 小时、滚动 7 天的金额折算成月额度的占比，以及各自的窗口上限（20% / 50%）。这是 Go 自己的双窗口限流口径，只做参考展示。
- 再下一行是「另有 N 个模型本月未使用」，对应 `summary.unusedCount`。
- 面板打开时每 60 秒自动刷新，也可以点 `⟳` 立刻刷。关掉面板就不再请求。
- 右上角 `⋯` 打开**详细用量**弹层。

> 面板窗口固定是**本自然月**（`period: 'month'`），每月 1 号归零。要按订阅周期看，用工具传 `period: 'cycle'`（起点由 `cycleStartDay` 决定）。

## 详细用量弹层

`⋯` 进入。中间一个对话框，纵向滚动：

- **总用量**一块，下面**每个本月用过的模型**各一块。每块标题是自己那一行「金额 / 额度占用」和 `tokens · 调用 · 会话`。
- 每块有**独立的** `日 / 月 / 会话` 三档：
  - `日`：24 小时折线，可以**跨月**翻日期（前后一天，不越过今天）；
  - `月`：当月每天的柱状，可以前后翻月份（不越过本月）；
  - `会话`：当月每个根会话一根柱，按金额排序。
- 每块的月份互不影响：一块停在 9 月，另一块看本月是正常状态。相同 `(month, date)` 的请求只发一次，走一张小的 LRU 缓存。
- 图是手写 SVG：Y 轴 `niceScale` 刻度、悬停 tooltip、状态切换 100ms 过渡（折线做点重采样 + 缓动，柱状做高度缩放）。加载中保留上一张图，读失败也保留并在块内给「重试」。
- **本月未使用（N）**：全历史出现过、但本月没用过的模型收在一个折叠组里，展开后每块默认落在**它上次使用的那个月**，标题标注「上次使用 YYYY年M月」。
- 打开弹层是 **stale-while-revalidate**：先渲染上次的缓存（不闪骨架屏），同时强制向宿主拉一次最新数据；弹层开着时每 30 秒后台 revalidate 一次可见的选择。缓存也用于「先出图再补数字」，所以切换月份不会白屏。

## 百分比口径

金额是主单位，百分比只是它的另一种说法：

- **模型百分比** = `该模型本月金额 / 该模型月额度`。免费档和未定价模型没有可选百分比。
- **总百分比** = `Σ(该模型金额 / 该模型额度)`，**不是** `总金额 / Σ额度`。Go 把额度当**一个共享池**，用后一种算法会在模型间单价差得多时严重失真。
- 面板和报告用同一套 `formatPercent`：`<0.01%` 以下给 `<0.01%`，1% 以下两位小数，100% 以下一位小数，100% 起取整。

## 计价

价目表来自 Go 官方文档（`https://opencode.ai/docs/go/` → Usage limits），单位 USD / 1M tokens：

- **DeepSeek V4.1 Flash**：off-peak `$0.15 / $0.60 / $0.003`（输入 / 输出 / 缓存读取），peak 翻倍（`$0.30 / $1.20 / $0.006`）。峰时 = UTC 01:00–04:00 与 06:00–10:00，周一到周五；其余时间（含整个周末）为谷时。月额度 `$100`。
- **DeepSeek V4 Pro**：off-peak `$0.66 / $1.98 / $0.022`，peak `$1.32 / $3.96 / $0.044`。月额度 `$15`。
- 其它模型（Kimi K3、GLM-5.3、Qwen3.8、Claude Haiku 5.5、Gemini 4 Argon…）单价固定，见 `lib/pricing.js`；两个免费档模型（`beam-free`、`iceman-contributor-free`）不计费用也不进额度池。
- 每个模型的**月额度**都内置了，报告、面板、弹层都用它算百分比。

**为什么按金额而不是 token 数分摊**：Go 的月额度是按美元计价的（每个模型一个额度），缓存读取比输出便宜两个数量级。按 token 数平摊会把缓存 token 当输出 token 卖，严重高估缓存型用法。所以默认 `basis: 'cost'`，也保留 `basis: 'tokens'` 备选。

### 改价 / 补模型

价目表会随 Go 调整，或者你用了表里没有的模型 id。在 `~/.dsh/token-split/pricing.json` 写覆盖（热加载，不用重启）：

```json
{
  "models": {
    "my-new-model": { "label": "My New Model", "input": 0.2, "output": 0.8, "cacheRead": 0.02, "cacheWrite": 0, "monthlyLimit": 20 }
  },
  "aliases": { "deepseek-flash": "deepseek-v4.1-flash" }
}
```

匹配顺序：精确 id → 别名 → 去掉 `-1017` 这类构建后缀 → 最长前缀匹配。匹配不到就是「未定价」，金额记 0 并在报告 / 面板 / 弹层里明确提示，不会静默吞掉。

### 和官网控制台对账

控制台（`opencode.ai/console`）统计的是**整个 key** 的用量：本机 DSH + 朋友那台机器 + 任何其他客户端。插件只统计**本机**、只统计 `opencode-go`。正常关系是：

```
控制台总额 ≈ 本机金额 + 朋友金额（+ 本机其他客户端）
```

实测过一次：控制台 `deepseek-v4.1-flash` 561 次请求 / $0.99，本机 336 次 / $0.724，差额 225 次 / 约 $0.27 正是朋友的用量。控制台里还出现过 `claude-haiku-5-5`（4 次），本机账本里没有这个模型，同样说明这个 key 被别的客户端用过。

对账时注意三点：

- **定价是对齐的**：拿控制台的 token 数套本仓库的价目表反推，$0.987 ≈ 显示值 $0.99，峰谷判定也一致。数字差只可能来自范围，不会来自单价。
- **差额自动包含所有非本机用量**，所以分摊时用「控制台总额 − 本机」比让朋友报数更稳。
- 两边都装插件时，本机 + 朋友应当≈控制台；差得多说明还有第三处客户端在用这个 key。

## HTTP 路由

面板和弹层都只读宿主路由，浏览器永远碰不到账本文件：

| 路由 | 作用 | 查询参数 |
| --- | --- | --- |
| `GET /token-split/summary` | 面板：窗口、总额、按模型、`unusedCount`、`allowances`（5h / 周） | `period`、`since`、`until` |
| `GET /token-split/timeline` | 详细用量：整月的日 / 时 / 会话序列 + 每个模型的序列 + `knownModels` | `month`（`YYYY-MM`）、`date`（`YYYY-MM-DD`） |
| `/api/token-split/summary`、`/api/token-split/timeline` | 上面两条在 `/api/` 命名空间下的同一实现（桌面渲染进程的 fetch 桥只保证转发 `/api/*`） | 同上 |

- **只读**：两条路由只做聚合返回，不写账本、不改配置。`GET` / `HEAD` / `POST` 都接受（POST 只是给只转发 JSON POST 的桥留的兼容口，语义仍是读）。
- **只接受 loopback**：非 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 一律 `403 {"error":"loopback-only"}`；方法不对返回 `405`；`cache-control: no-store`。
- **只回聚合数字**：`summary` 返回总额与模型行，`timeline` 返回按月 / 按天 / 按小时的序列，都不返回逐条记录。

## 工具

对 Agent 说（不传 `period` 时默认**本自然月**）：

- 「这个月我用了多少？」 → `token_usage({})`
- 「这个订阅周期我用了多少？」 → `token_usage({ period: 'cycle' })`
- 「最近 30 天呢？」 → `token_usage({ period: 'last30' })`
- 「按天看」 → `token_usage({ detail: 'daily' })`
- 「朋友用了 0.8 美元，月费 10，我该出多少？」 → `token_usage({ otherCost: 0.8, monthlyFee: 10 })`
- 「存一份明细」 → `save: true`

报告样例：

```
**本机用量** · 2026-11-01 ~ 2026-11-30 · 用户 `alice` · 来源 `opencode-go`

| 项目 | 数值 |
| --- | ---: |
| 调用次数 | 189 |
| 输入（未缓存） | 829,430 |
| 缓存读取 | 36,226,816 |
| 输出 | 238,305 |
| 合计 tokens | 37,294,551 |
| **按 Go 定价的金额** | **$0.446** |
| **占 Go 月度额度** | **0.45%** |
| 会话数 | 3 |

> 额度窗口（占月额度）：5h 0.02%/20% · 周 0.09%/50%

按模型（额度 = 本周期已用 / Go 月额度）：

| 模型 | 调用 | tokens | 金额 / 额度占用 | 构成 | 额度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | 189 | 37,294,551 | $0.446 / 0.45% | 100.0% | $100 |
```

## 数据在哪

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/token-split/ledger.json` | 账本（`0o600`，原子写） |
| `~/.dsh/token-split/pricing.json` | 你的价目覆盖（可选） |
| `<工作目录>/token-usage-<起>.md` / `.csv` | `save: true` 的产物 |

## 验证

```powershell
npm test          # 157 个用例
```

CI（`.github/workflows/ci.yml`）在 Node 24 上跑同一套测试。测试需要 `react` / `react-dom` 才能渲染浏览器半，所以它们是 **devDependencies**——插件本体运行时零依赖，装到 DSH 里不需要这两个包。

在本机跑（复用已装 DSH 的 `@deepseek-ai/*` 与 react）：

```powershell
# 指向一个含 @deepseek-ai/dsh-client-runtime、react、react-dom 的 node_modules
$env:DSH_PROFILE_MODULES='<某个 node_modules 目录的绝对路径>/'
node --import ./test/register.mjs test/run.mjs
```

`test/resolve-hook.mjs` 按这个顺序找模块根：`DSH_PROFILE_MODULES` → `DSH_HOME/profiles/node_modules` → `~/.dsh/profiles/node_modules`；都找不到会直接给出可读的报错而不是静默跳过。

覆盖：折叠优先级、账本损坏恢复、峰谷判定、价目匹配与覆盖、聚合与 provider 过滤、分摊数学、额度百分比（模型 / 共享池）、滚动 5h / 周窗口、HTTP 路由（200/403/405）、timeline 的月 / 日 / 会话序列与 `knownModels`、未使用模型折叠组、SWR 缓存与 30 秒 revalidate、以及客户端 bundle 的 factory / 注册 / 面板与弹层渲染（用 react-dom/server 断言）。

用本机真实日志离线核对（解码 zstd 分帧、复用同一份 `lib/fold.js` 与价目表）：

```powershell
node --import ./test/register.mjs scripts/verify-history.mjs
```

## 已知限制

- 只统计 DSH 自己发出的请求。同一个 key 被 opencode CLI 等别的客户端用掉的量看不到。
- 面板固定**本自然月**。想让面板跟订阅周期走，目前得改 `cycleStartDay` 的语义或用工具看 `period: 'cycle'`。
- 分段计价（Grok 4.7 > 200K、Qwen3.7 Plus > 256K、GPT Luna > 272K、Claude Haiku > 100K、MiniMax M3 > 512K）按基础档计价：一条用量样本只有 token 桶，没有当次上下文长度。
- 峰谷按请求开始时间（事件时间）判定，跨边界的请求按开始时刻算。
- 单机单账本：两个 DSH 进程同时写同一文件是后写覆盖。
- 面板与弹层都需要宿主有 `ctx.webServer`（Web / 桌面版都有；headless 没有，此时面板显示服务未就绪，工具照常可用）。
- 5h / 周窗口是**本机**口径的近似：它按本机记录的时刻滚动求和，不是服务端真实的限流计数。

## 结构

```
lib/index.js    宿主插件：配置、事件订阅、补录、两条 HTTP 路由、token_usage 工具
lib/fold.js     纯函数：事件 → 用量样本，步骤级优先级
lib/ledger.js   账本：内存状态 + 防抖原子写
lib/pricing.js  Go 价目表、峰谷判定、模型匹配、额度与共享池百分比
lib/report.js   纯函数：窗口、聚合、分摊、额度小字、Markdown/CSV
lib/timeline.js 纯函数：整月的时 / 日 / 会话序列 + knownModels
lib/history.js  会话日志枚举与 zstd 分帧读取
lib/fsutil.js   数据目录与原子写
lib/client.js   浏览器半：侧边栏 chip + 面板 + 详细用量弹层（lazy-CJS bundle）
scripts/        离线核对脚本
test/           157 个用例
```

## 版本记录

**0.3.0**（2026-11-01）

- 面板金额旁新增额度百分比（模型 `$0.446 / 0.45%`），总金额旁是共享池口径的总百分比。
- 默认统计窗口从「最近 30 天」改为**本自然月**。
- 面板底部新增 `5h …/20% · 周 …/50%` 滚动窗口小字。
- 新增**详细用量**弹层（`⋯`）：总用量 + 每模型一块，各自独立的 `日 / 月 / 会话` 与时间翻页，手写 SVG 图 + 悬停 tooltip + 100ms 过渡。
- 新增 `GET /token-split/timeline` 路由，返回 `knownModels`（全历史模型清单，含 `lastMonthKey` / `lastMonthCost`）。
- 本月未使用的模型收进「本月未使用（N）」折叠组，展开后落在它上次使用的月份。
- 前端改为 stale-while-revalidate：先出缓存再强制刷新，弹层开着每 30 秒 revalidate。
- 子会话用量并入根会话，会话数按根会话计。
- `summary` 新增 `unusedCount`。

更早的版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 截图

| 面板 | 详细用量弹层 |
| --- | --- |
| _（截图占位：侧边栏 chip + 面板，含金额 / 百分比 / 按模型 / 5h·周小字）_ | _（截图占位：弹层，总用量块 + 模型块，日 / 月 / 会话三档图）_ |
