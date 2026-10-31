# dsh-token-split

给 **DSH** 用的本机 OpenCode Go 记账插件：只统计 `opencode-go` 这一条来源的用量，按 Go 官方价目表（含 DeepSeek 峰谷价）算出美元金额，在侧边栏显示，并把包月订阅费按金额比例分摊到人头。

> 场景：你和朋友共享一个 `opencode go` 订阅（同一个 key），两台机器各装各的 DSH。插件只统计**本机**、只统计**这个 provider** 的用量，朋友那台机器跑同一个插件，两边报出各自的金额，就能算出谁该出多少。

## 它做什么

1. **只记 opencode-go**：每条记录带 provider，报告和面板默认只算 `providers: ['opencode-go']`。你自己用 deepseek 官方 key、qianfan 等其它来源的消耗一律不进账。
2. **实时记账 + 历史补录**：订阅 `session/event` 折叠每条 `assistant/message.usage`；启动时通过 `ctx.sessionQuery` 把已有会话日志补录一遍。补录幂等，重启不重复。
3. **按 Go 价目表计价**：`lib/pricing.js` 内置 Go 文档里的 30 个模型单价（USD / 1M tokens），DeepSeek V4.1 Flash 与 V4 Pro 自动区分峰谷时段，并按每个模型的月额度（如 V4.1 Flash $100）显示额度占用。
4. **侧边栏面板**：侧边栏底部一个金额 chip，点开是「本周期金额 / 按模型 / 分摊计算器」。数据来自宿主只读路由 `GET /token-split/summary`。
5. **工具与导出**：`token_usage` 工具出 Markdown 报告；`save: true` 额外写 `.md` 和逐步 `.csv`。

## 安装

**从 GitHub 装（推荐，朋友也是这条命令）：**

```powershell
dsh plugin --profile desktop add github:UserJCY/dsh-token-counter
```

**从本地目录装（改代码时用）：**

```powershell
dsh plugin --profile desktop add file:D:\Programs\dsh-token-counter
```

`dsh plugin add` 会自己把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`。然后**重启 DSH**。

重启后：`~/.dsh/token-split/ledger.json` 出现，历史补录在后台跑完，侧边栏底部出现金额 chip。

### 更新

git 依赖按 commit 拉取，`file:` 依赖是拷贝，两种都要重装才会生效：

```powershell
dsh plugin --profile desktop remove dsh-token-split
dsh plugin --profile desktop add github:UserJCY/dsh-token-counter
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
    user: jerry
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
| `cycleStartDay` | `1` | 周期起点（1–28）。 |
| `fxRate` | `0` | 美元兑人民币汇率；> 0 时报告额外给人民币参考。 |
| `pricingFile` | `''` | 额外的价目覆盖文件；留空只读数据目录下的 `pricing.json`。 |
| `includeSubagents` | `true` | 子代理会话是否计入本机。 |
| `backfill` | `true` | 启动时补录历史。 |
| `reportDir` | `''` | `save` 落盘目录；空 = 当前会话工作目录。 |

## 侧边栏面板

侧边栏底部（设置按钮旁边）一个 chip，显示**最近 30 天**的金额；点开：

- 最近 30 天（滚动窗口，不是自然月）的金额、tokens、调用次数、会话数
- 按模型：金额 + 占比条（未定价模型会变淡并提示）

数据 60 秒自动刷新，也可以点右上角 ⟳。面板只在打开时请求，关掉就不占资源。

> 面板的窗口是滚动的 30 天，所以每月 1 号不会归零。要按自然月或订阅周期看，用工具传 `period: 'cycle'`（周期起点由 `cycleStartDay` 决定）。

## 计价

价目表来自 Go 官方文档（`https://opencode.ai/docs/go/` → Usage limits），单位 USD / 1M tokens：

- **DeepSeek V4.1 Flash**：off-peak `$0.15 / $0.60 / $0.003`（输入 / 输出 / 缓存读取），peak 翻倍（`$0.30 / $1.20 / $0.006`）。峰时 = UTC 01:00–04:00 与 06:00–10:00，周一到周五；其余时间（含整个周末）为谷时。
- **DeepSeek V4 Pro**：off-peak `$0.66 / $1.98 / $0.022`，peak `$1.32 / $3.96 / $0.044`。
- 其它模型（Kimi K3、GLM-5.3、Qwen3.8、Claude Haiku 5.5、Gemini 4 Argon…）单价固定，见 `lib/pricing.js`。
- 每个模型的**月额度**也内置了（V4.1 Flash `$100`、Kimi K3 `$15`…），报告和面板按「本周期已用 / 额度」展示。

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

匹配顺序：精确 id → 别名 → 去掉 `-1017` 这类构建后缀 → 最长前缀匹配。匹配不到就是「未定价」，金额记 0 并在报告/面板里明确提示，不会静默吞掉。

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

## 工具

对 Agent 说（不传 `period` 时默认最近 30 天）：

- 「最近一个月我用了多少？」 → `token_usage({})`
- 「这个订阅周期我用了多少？」 → `token_usage({ period: 'cycle' })`
- 「按天看」 → `token_usage({ detail: 'daily' })`
- 「朋友用了 0.8 美元，月费 10，我该出多少？」 → `token_usage({ otherCost: 0.8, monthlyFee: 10 })`
- 「存一份明细」 → `save: true`

报告样例：

```
**本机用量** · 2026-10-01 ~ 2026-10-31 · 用户 `Jerry` · 来源 `opencode-go`

| 项目 | 数值 |
| --- | ---: |
| 调用次数 | 189 |
| 输入（未缓存） | 829,430 |
| 缓存读取 | 36,226,816 |
| 输出 | 238,305 |
| 合计 tokens | 37,294,551 |
| **按 Go 定价的金额** | **$0.376** |
| 会话数 | 3 |

按模型（额度 = 本周期已用 / Go 月额度）：

| 模型 | 调用 | tokens | 金额 | 占比 | 额度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | 189 | 37,294,551 | $0.376 | 100.0% | $100 |
```

## 数据在哪

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/token-split/ledger.json` | 账本（`0o600`，原子写） |
| `~/.dsh/token-split/pricing.json` | 你的价目覆盖（可选） |
| `<工作目录>/token-usage-<起>.md` / `.csv` | `save: true` 的产物 |

面板走 `GET /token-split/summary`：**只读**、只接受 loopback（127.0.0.1 / ::1）、返回聚合数字而不是逐条记录、`cache-control: no-store`。账本文件本身不经过浏览器。

## 验证

```powershell
npm test          # 79 个用例
```

覆盖：折叠优先级、账本损坏恢复、峰谷判定、价目匹配与覆盖、聚合与 provider 过滤、分摊数学、HTTP 路由（200/403/405）、以及客户端 bundle 的 factory / 注册 / 面板渲染（用 react-dom/server 渲染断言）。

用本机真实日志离线核对（解码 zstd 分帧、复用同一份 `lib/fold.js` 与价目表）：

```powershell
node --import ./test/register.mjs scripts/verify-history.mjs
```

本机输出：历史里 `deepseek-official=7367 / deepseek-account=620 / qianfan=154 / opencode-go=189`，过滤后只算 opencode-go 的 189 步 = **$0.376**。这正是「只统计 opencode 来源」的效果。

## 已知限制

- 只统计 DSH 自己发出的请求。同一个 key 被 opencode CLI 等别的客户端用掉的量看不到。
- 分段计价（Grok 4.7 > 200K、Qwen3.7 Plus > 256K、GPT Luna > 272K、Claude Haiku > 100K、MiniMax M3 > 512K）按基础档计价：一条用量样本只有 token 桶，没有当次上下文长度。
- 峰谷按请求开始时间（事件时间）判定，跨边界的请求按开始时刻算。
- 单机单账本：两个 DSH 进程同时写同一文件是后写覆盖。
- 面板需要宿主有 `ctx.webServer`（Web/桌面版都有；headless 没有，此时面板会显示服务未就绪，工具照常可用）。

## 结构

```
lib/index.js    宿主插件：配置、事件订阅、补录、HTTP 路由、token_usage 工具
lib/fold.js     纯函数：事件 → 用量样本，步骤级优先级
lib/ledger.js   账本：内存状态 + 防抖原子写
lib/pricing.js  Go 价目表、峰谷判定、模型匹配、覆盖文件
lib/report.js   纯函数：窗口、聚合、分摊、Markdown/CSV
lib/client.js   浏览器半：侧边栏 chip + 面板（lazy-CJS bundle）
scripts/        离线核对脚本
test/           79 个用例
```
