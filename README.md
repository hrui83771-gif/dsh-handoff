# dsh-handoff

DeepSeek Harness 的**跨会话上下文接力**插件。

dsh 自带的 compaction（`ctx.compaction` / `dsh-compaction-basic`）解决的是**同一会话内**上下文膨胀——隐藏旧条目、保留尾部。它解决不了另一件事：**新会话永远从零开始**。这个插件补的就是那个缺口。

```
① 监测   tokenMeter 每个 step 采一次 → 60% 提醒 / 80% 建议交接（并自动落一份包）
② 蒸馏   事实从会话日志派生（含失败教训）+ 结论由模型补写 → pack.json（命令先脱敏再落盘）
③ 注入   新会话 startup 时自动注入 L0 摘要，细节由 recall_context 按需取
         过期包（默认 3 天）注入时带显式警告；本机没有就按 git remote 找镜像；
         cwd 不在仓库内时，等第一个带路径的工具调用反推仓库根再补一次（延迟接力）
         连续接力时 L0 带"近几次交接的演化"弧线，文件/待办只带相对前几次的增量
④ 断点   compaction 压缩前自动落一份纯事实包：被压掉的细节之后还能 recall_context 找回
⑤ 检索   recall_context(query="...") 跨所有历史包（本机 + 远端镜像）全文检索
```

## 为什么"事实自动、结论手写"

事件日志是**事实**的权威来源，但它不知道**结论**。

- `tool/call` 的 `arguments`（JSON 字符串）里有真实改过的文件、跑过的命令
- `tool/result` 里有失败的调用（`isError` + `error.reason`）和反复重跑的命令——蒸馏成 `deadEnds` 一节：新会话最贵的浪费就是重蹈覆辙
- `todo/write` 里有模型自己维护的待办状态，最后一次写就是最终状态
- `session/title` 比第一条用户消息更适合当"目标"

这些都免费、确定、不会编。但"这次到底做完了什么、下一步该怎么走"只有当时那个模型知道——`v0.2` 曾试图从 assistant 的散文里拼，结果拼出来的是"复述用户原话"。

所以现在：文件/命令/待办/标题/规模一律自动派生，`summary` / `nextStep` / `openQuestions` / `refs` 由 `handoff_save` 传入。模型不传时，`v0.4` 会补一次 `ctx.llm.stream()` 结构化调用（一次、低温、30s 超时，`DSH_HANDOFF_SYNTH=0` 可关）；补写失败才退化成纯事实包。补出来的结论会标 `conclusionSource: 'synth'`，和模型在会话里亲口写的（`'brief'`）区分开——**绝不拿散文冒充结论**。

## 为什么分层注入

一次性把整个交接包塞进新会话，等于把膨胀问题搬到下一个会话，第二次交接只会更糟。所以：

| 层 | 内容 | 体量 | 何时进上下文 |
|---|---|---|---|
| L0 | 目标、交接点、演化弧线、详细交接指针、下一步、结论、失败教训、已完成（增量）、改动文件（增量）、未决问题 | ≤ 4000 字符 | 新会话自动注入 |
| L1 | focus / progress / done / files / commands / deadEnds / refs / prompts / openQuestions 分节 | 每节按需 | 模型调 `recall_context(section)`；`query` 则跨全部历史包全文检索 |
| L2 | 原始会话 | 不限 | 用 `fromSession` 回溯 |

**多包合并与差异注入**：连续接力多个会话后，L0 头部带"近几次交接的演化"弧线（前 3 份包的时间序一句话摘要），中间会话不再丢；文件和已完成待办只带**相对前几次的增量**，重复内容不重复罗列，被吞掉的数量以注脚说明（"另有 N 个文件在前几次交接里"）。弧线只看本机包链（远端镜像只存 latest）。

## 目录

```
src/
├─ index.ts      # apply：挂 agent/created、session/event、工具、命令、投递
├─ meter.ts      # ctx.tokenMeter 采样 + 阈值
├─ distill.ts    # 事实派生（事件日志）+ 结论合并（brief）+ 命令脱敏
├─ pack.ts       # 数据结构、落盘/镜像、L0 渲染、分节读取、新鲜度
├─ brief.ts      # 模型没写结论时的一次性结构化补写（ctx.llm.stream）
├─ git.ts        # 仓库身份（remote/branch/commit），跨机器接力用
├─ workspace.ts  # 工作区身份（realpath + hash）+ 远端 key 目录
└─ compat.ts     # 唯一对接 dsh 类型/事件的文件，dsh 升级后先看这里
dist/            # tsc 产物，dsh 实际加载的是这里
scripts/
├─ smoke.mjs          # 离线冒烟测试，直接测 dist（70 项断言）
├─ mock-run.mjs       # 假 ctx 端到端：apply() → 注入/投递/补写/断点/延迟接力/弧线/检索（48 项断言）
├─ fixtures/mock-ctx.mjs # 共享假环境：会话/agent/ctx，两个测试共用一套契约
├─ replay-distill.mjs # 拿真实会话日志回放蒸馏，可 --brief / --save
├─ verify-pack.mjs    # 只读校验落盘包 + 预览 L0
├─ session-log.mjs    # 多帧 zstd 解码 + 会话日志读取
├─ inspect-session.mjs # 解压会话日志、统计事件类型（排查用）
└─ asar-read.mjs      # 从 app.asar 里读任意文件（核对桌面版真实类型）
```

## 跑起来

**1. 先验证纯逻辑（不需要 dsh）**

```sh
pnpm install      # 装 @deepseek-ai/dsh-tools@0.2.1-rc.3 和类型
pnpm build        # tsc → dist/
pnpm test         # 冒烟 70 项 + 端到端 48 项
```

冒烟测试直接测 `dist/`——也就是 dsh 真正加载的那份 JS：事实派生（文件/命令/待办合并/标题/失败教训）、结论合并、L0 预算裁剪（含弧线/增量）、refs 解析、注入消息形状、工作区 key 稳定性、上下文窗口解析，以及命令脱敏、远端 key、新鲜度、历史包列表、多包读取、`parseBrief` 解析。

`mock-run.mjs` 用假 ctx 真的调用 `apply()`：工具/命令注册、`agent/created(startup)` 注入、`resume`/subagent 跳过、`recall_context` 分节（含 `packId` 和 `deadEnds`）、80% 自动落盘、`/handoff` 官方 `handler` 契约、命令脱敏、`handoff_list`、`toSession` 投递、结论自动补写（含关闭开关）、过期包警告、compaction 断点、`/handoff` 子命令（list/show/restore）、延迟接力（临时打开 git、配真仓库验证反推链路）、多次接力后的弧线 + 差异注入、`recall_context(query=...)` 全文检索。假的 commands 服务按桌面版的真实校验逻辑写（`handler` 不是函数就 `throw`），默认的 `llm.stream` 直接抛错——模型调用失败时插件必须退回纯事实包。全程 `DSH_HOME` 指向临时目录，`DSH_HANDOFF_NO_GIT=1` 让 git 探测确定性关闭，不碰真实 `~/.dsh`。

想验证真实会话抽出来的东西，用回放：

```sh
node scripts/replay-distill.mjs "<会话目录或 .jsonl.zstd>" --out=out.txt
node scripts/replay-distill.mjs "<会话目录>" --brief=brief.json --out=out.txt   # 带模型结论
```

`--brief` 传 `{goal, summary, nextStep, openQuestions, refs}`，就能对比"只有事实"和"事实+结论"两种包。需要支持 zstd 的 Node（v22.15+ / v24+）。

**2. 挂到桌面版 DSH NEXT**

桌面版读 `~/.dsh/profiles/desktop/cordis.patch.yml`。在末尾加一段 insert，指向编译产物：

```yaml
- insert:
    - id: handoff
      name: "D:/BCGD/dsh-handoff/dist/index.js"
```

重启 DSH NEXT，`~/.dsh/logs/desktop-next.log` 里应出现：

```
[dsh-handoff] loaded · packs=C:\Users\hen'r'y'hu'g'y\.dsh\handoff
[dsh-handoff] window deepseek-official/deepseek-flash = 1,000,000 tok (adapter)
```

插件自带 `@deepseek-ai/dsh-tools@0.2.1-rc.3`（lib 与桌面版内置的 `0.2.1-rc.2` 逐字节相同），所以放在任何目录都能解析，不用挪进 dsh 仓库。

**3. 用一遍**

1. 聊几轮 → 让模型调 `handoff_save`，最好**传 `summary` / `nextStep` / `openQuestions` / `refs`**（不传也会补一次模型调用，但自己写的更准）；或 `/handoff <一句话结论>`
2. 检查 `~/.dsh/handoff/<workspace-key>/latest.json`（`<workspace-key>` 是工作区真实路径的 sha1 前 12 位）
3. 开新会话 → 首条消息发出去后，会话开头应出现交接摘要（日志里会打印 `restored pack ...`）
4. 问模型"上次改了哪些文件" → 它应该调 `recall_context(section="files")`；问"上次试过什么没成" → `section="deadEnds"`；问"还有哪些历史交接" → `handoff_list`；问某个具体线索（人名/报错/功能名）→ `recall_context(query="...")` 跨全部历史包搜
5. 想把摘要投给另一个正在跑的会话：`handoff_save(..., toSession="<会话 id>")` 或 `/handoff --to <会话 id> <结论>`
6. 自己在命令面板里翻/恢复：`/handoff list`、`/handoff show <包 id>`、`/handoff restore <包 id>`（把某份历史包注入当前会话）

## 与 dsh 类型的对接

`src/compat.ts` 是唯一直接对接 dsh 类型的文件，内容全部按官方 `.d.ts` 写（dsh `0.2.1-rc.3`；lib 与桌面版内置的 `0.2.1-rc.2` 逐字节相同，rc.3 只是内部依赖 pin 的 bump），不是猜的：

| 对接点 | 来源 | 确认方式 |
|---|---|---|
| `UserMessage` / `MessageSourceMap` | `@deepseek-ai/dsh-llm/message` | 声明合并新增 `handoff` kind（官方说明这是扩展点） |
| `Session` / `SessionEvent` | `@deepseek-ai/dsh-session` | `session/event(session, event)` |
| `Agent` / `AgentRegistry` | `@deepseek-ai/dsh-agent` | `inject(message)`、`ctx.agents.get(id)`、`currentInitiator()` |
| `agent/created` | `@deepseek-ai/dsh-agent` | 载荷 `{ agent, source: 'startup' \| 'resume' \| 'clear' \| 'compact' }` |
| `tokenMeter.measure` | `@deepseek-ai/dsh-token-meter` | `measure(session): TokenMeasurement`，含 `totalTokens` |
| `defineTool` / `ctx.tools.register` | `@deepseek-ai/dsh-tools` | 编译期校验 |
| `ctx.llm.stream(GenerateOptions)` | `@deepseek-ai/dsh-llm` | `text-delta` 拼接，`RequestUserInput` 不带 id/source |
| `ctx.agents.get / list` | `@deepseek-ai/dsh-agent` | `toSession` 投递按 SessionId 找运行中的会话 |
| `tool/result`（`isError` / `error.reason`） | `@deepseek-ai/dsh-session` | 失败教训（deadEnds）按 `callId` 与 `tool/call` 配对 |
| `compaction/start` 会话事件 | dsh-compaction（桌面版内置） | 扩展事件（不在 rc.3 类型联合里），按字符串比较；压缩前落断点包 |
| `CommandDefinition` / `CommandInvocation` | `@deepseek-ai/dsh-commands` | `register(definition)` 强制 `handler` 是函数，返回 `CommandResult`；已核对桌面 asar 内置实现 |

`commands` 注册已不再是形状探测。`@deepseek-ai/dsh-commands` 现在发布到 `0.2.1-rc.3`（`next` 标签），契约是 `register(CommandDefinition)` 且强制 `definition.handler` 是函数——旧的 `{run, execute}` 形状会被 `TypeError` 拒掉，这正是 `/handoff` 之前一直没挂上的原因：两种探测形式都栽在缺 `handler`，失败又被静默吞了。现在按官方类型写 handler（`invocation.rawInput` → `CommandResult`），`dsh-commands` 只 `import type`，运行时用宿主自己的 commands 服务实例，不打进插件产物。`commands` 服务缺席的 profile（web/headless）仍静默降级到 `handoff_save` 工具。

## 版本对齐

插件把 `@deepseek-ai/dsh-tools` 作为自己的依赖固定成 `0.2.1-rc.3`（与桌面版内置的 `0.2.1-rc.2` 的 lib 逐字节相同）。dsh 升级后要同步改这个版本号再 `pnpm install`，否则 `defineTool` 产出的对象可能对不上新的 `ToolDefinition` 形状。注意这些包的 `latest` dist-tag 还停在老版本，新版本都在 `next` 标签上，`pnpm add @deepseek-ai/dsh-tools@next` 才装得到。

## 已知边界

- **注入不唤醒 driver。** `agent.inject()` 只是排进 `next-step`，要等用户第一条消息唤醒才被 claim。这是刻意的：自动 `followup()` 会烧一次用户没要求的请求。
- **`resume` / `clear` / `compact` 不注入**，只对 `source === 'startup'` 生效，避免同一份摘要被反复塞进上下文。
- **子会话不注入。** `header.origin === 'subagent'` 或 `delegationDepth > 0` 的会话会跳过，否则每个 subagent 都会白背一份父会话摘要。
- **阈值必须早于 compaction。** 默认 60%/80%。窗口不是写死的：插件用 `ctx.llm.resolveModelInfo(provider, model)` 读适配器声明的 `contextWindow`，读不到才退回 1,000,000，并在日志里打印实际取到的值。想强制指定就设 `DSH_HANDOFF_WINDOW`。
- **结论优先用模型亲口写的。** `handoff_save` 传了 `summary` 就直接用；没传时补一次 `ctx.llm.stream()` 结构化调用（一次、低温、600 token、30s 超时），失败才退化成事实性活动统计。补写的结论标 `conclusionSource: 'synth'`，`handoff_list` 里能看出来源。`DSH_HANDOFF_SYNTH=0` 可整体关闭。
- **命令落盘前脱敏。** 密钥形状（`Bearer xxx`、`sk-…`、`TOKEN=xxx`、URL 密码）在写进 pack 之前打码——pack 会持久化到 `~/.dsh/handoff/` 再注入新会话，这是唯一可能把密钥带出会话的路径。宁可错杀（`--token=x` 也被打码）不留真值。
- **过期包注入时带警告。** 默认 3 天过期线（`DSH_HANDOFF_MAX_AGE_DAYS`，`0` 关掉判断）；过期包照样注入，但 L0 第一行是显式警告，让模型先确认现状再参考，不要照抄一周前的"下一步"。
- **80% 会自动落一份包**，防止模型没来得及交接就断了。它不会覆盖本会话已经存过的包（那多半带模型结论）。llm 补写失败时这份是纯事实包。
- **跨机器接力靠 git remote 镜像。** workspace-key 是本地路径 hash，换机器必然对不上；落盘时往 `~/.dsh/handoff/remote-<key>/` 镜像一份（key 按归一化 origin 算），本机找不到包时按当前仓库 origin 兜底查找。
- **延迟接力补"cwd 不在仓库内"的缺口。** 用户在家目录开会话改 `D:` 上的仓库时，startup 阶段拿不到 origin；插件会等第一个带路径参数的工具调用，按文件所在目录反推仓库根再找镜像（`git -C` 自己向上找根）。限制：每个会话最多试 3 次；反推依赖工具参数里有真实存在的路径，所以第一条消息纯聊天、没动过文件的会话接不上——这种情况用 `/handoff restore`。
- **失败教训（deadEnds）是启发式。** 失败来源是 `tool/result` 的 `isError`（或 `error.reason`）；另外同一命令出现 ≥2 次会标成"第一次多半没成功"——重跑也可能是故意的（比如改完再跑），所以文案是提示不是定论。deadEnds 同样过脱敏。
- **compaction 前自动落断点包**（`trigger: 'compaction'`），被压掉的细节之后还能 `recall_context` 找回；本会话已存过包时不覆盖（那多半带模型结论）。断点包刻意不补写结论——compaction 本身已经在跑模型请求，这里必须快。
- **`/handoff` 子命令按首个词匹配**：`list` / `show <id>` / `restore <id>`。副作用：以这三个词开头的普通结论会被当成子命令（`/handoff list all the TODOs`）——遇到这种措辞改用 `handoff_save` 工具或换个开头。
- **弧线/增量只看本机包链。** 远端镜像只存 latest，所以换机器后第一次接力没有弧线（增量退化为全量）；从第二份包起恢复正常。弧线取前 3 份、检索取前 20 份包，都是硬上限。
- **全文检索是子串匹配，不是分词检索。** 每包每分节取第一条命中行、最多 20 条，够定位"在哪份包的哪一节提到过"；要全文细节再用 `packId` + `section` 精读。英文大小写不敏感，中文按原样子串匹配。
- **`toSession` 只投递给运行中的会话**（`ctx.agents.get` 找得到的），inject 不唤醒 driver，目标会话要等下一条用户消息才 claim。会话列表在投递失败的返回值里。
- **相对 `refs` 会先按 workspace、再按项目根解析。** 项目根从改动最多的文件推公共目录——用户常在家目录开会话去改 `D:` 上的仓库，光看 workspace 会解析错。
- pack 存在 `~/.dsh/handoff/<workspace-key>/`（不写进用户项目），保留最近 20 份，可手动编辑。`<workspace-key>` 由工作区真实路径的 sha1 前 12 位算出，所以同一项目经软链接或盘符大小写变化仍指向同一目录。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_HANDOFF_WINDOW` | 读适配器，读不到 1,000,000 | 强制上下文窗口（token） |
| `DSH_HANDOFF_SYNTH` | 开 | 设 `0` 关闭"结论自动补写" |
| `DSH_HANDOFF_MAX_AGE_DAYS` | 3 | 过期线（天）；`0` 关掉过期判断 |
| `DSH_HANDOFF_NO_GIT` | 未设 | 测试用：设任意值跳过 git 探测 |

## 下一步路线

1. ~~pack 之间做"差异注入"~~ ✓ v0.6.0
2. ~~多包合并：L0 带"几个会话以来的进展弧线"~~ ✓ v0.6.0
3. ~~`recall_context(query=...)` 全文检索~~ ✓ v0.6.0
4. 压力提示接到 UI——**调研结论（v0.6.0）**：Web 生态的落点是 `@deepseek-ai/dsh-client-ui-slots` 的 `conversation.input.right` 槽位（`deepseek-harness-compaction-ui` 即此：esbuild 打一个 React 客户端 bundle，`package.json` 的 `dsh.client` 声明注入，后端经 `ctx.inject(['webServer'])` 注册 `/_plugins/<id>/settings` 路由给前端轮询）。**但当前桌面版（DSH NEXT asar 已核对）没有 `webServer` 服务、没有 `__ModuleLoader__`、也没有第三方客户端插件加载器**——槽位系统只被内置 UI 自用。等桌面版开放客户端插件加载后再做；届时后端沿同一模式加一条路由，数据直接复用现有的压力采样和 `handoff/pressure` / `handoff/restored` 事件。
5. pack TTL 清理：`~/.dsh/handoff/` 目前只按数量截断（20 份），可加按年龄清理（与过期线联动）
6. 弧线跨机器：远端镜像目前只存 latest，可改为存最近 N 份，让换机后也有弧线

## 生态里已有的两个同方向插件

- `billion-context-dsh` — ACP 式压缩，替换 compaction 后端，压缩后仍可 `decompress` / `search_context`。它的 L2 检索思路可以直接复用。
- `deepseek-harness-compaction-ui` — 给官方压缩做阈值配置卡片和进度圆环。架构（v0.6.0 调研）：后端 `web-settings.js` 经 `ctx.inject(['webServer'])` 注册同源 HTTP 路由；前端是 esbuild 打包的 React IIFE（`package.json` 里 `dsh.client` 声明 peer 注入 + `dsh.bundle.patch` 改宿主插件配置），运行时经 `window.__ModuleLoader__.load` 加载，用 `ctx.slots.inject('conversation.input.right', ...)` 把圆环挂到输入框右侧、`'settings.plugin.item'` 挂设置卡。只适用于托管 Web 版。

两者都做**会话内**，本插件做**会话间**，可共存。
