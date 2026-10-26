# dsh-handoff

DeepSeek Harness 的**跨会话上下文接力**插件。

dsh 自带的 compaction（`ctx.compaction` / `dsh-compaction-basic`）解决的是**同一会话内**上下文膨胀——隐藏旧条目、保留尾部。它解决不了另一件事：**新会话永远从零开始**。这个插件补的就是那个缺口。

```
① 监测   tokenMeter 每个 step 采一次 → 60% 提醒 / 80% 建议交接（并自动落一份纯事实包）
② 蒸馏   事实从会话日志派生 + 结论由模型补写 → pack.json
③ 注入   新会话 startup 时自动注入 L0 摘要，细节由 recall_context 按需取
```

## 为什么"事实自动、结论手写"

事件日志是**事实**的权威来源，但它不知道**结论**。

- `tool/call` 的 `arguments`（JSON 字符串）里有真实改过的文件、跑过的命令
- `todo/write` 里有模型自己维护的待办状态，最后一次写就是最终状态
- `session/title` 比第一条用户消息更适合当"目标"

这些都免费、确定、不会编。但"这次到底做完了什么、下一步该怎么走"只有当时那个模型知道——`v0.2` 曾试图从 assistant 的散文里拼，结果拼出来的是"复述用户原话"。

所以现在：文件/命令/待办/标题/规模一律自动派生，`summary` / `nextStep` / `openQuestions` / `refs` 由 `handoff_save` 传入。模型不传就退化成纯事实包，**绝不拿散文冒充结论**。

## 为什么分层注入

一次性把整个交接包塞进新会话，等于把膨胀问题搬到下一个会话，第二次交接只会更糟。所以：

| 层 | 内容 | 体量 | 何时进上下文 |
|---|---|---|---|
| L0 | 目标、交接点、详细交接指针、下一步、结论、已完成、改动文件、未决问题 | ≤ 4000 字符 | 新会话自动注入 |
| L1 | focus / progress / done / files / commands / refs / prompts / openQuestions 分节 | 每节按需 | 模型调 `recall_context(section)` |
| L2 | 原始会话 | 不限 | 用 `fromSession` 回溯 |

## 目录

```
src/
├─ index.ts      # apply：挂 agent/created、session/event、工具、命令
├─ meter.ts      # ctx.tokenMeter 采样 + 阈值
├─ distill.ts    # 事实派生（事件日志）+ 结论合并（brief）
├─ pack.ts       # 数据结构、落盘、L0 渲染、分节读取
├─ workspace.ts  # 工作区身份（realpath + hash，不用裸 cwd 字符串）
└─ compat.ts     # 唯一对接 dsh 类型/事件的文件，dsh 升级后先看这里
dist/            # tsc 产物，dsh 实际加载的是这里
scripts/
├─ smoke.mjs          # 离线冒烟测试，直接测 dist（41 项断言）
├─ mock-run.mjs       # 假 ctx 端到端：apply() → agent/created → 注入（24 项断言）
├─ replay-distill.mjs # 拿真实会话日志回放蒸馏，可 --brief / --save
├─ verify-pack.mjs    # 只读校验落盘包 + 预览 L0
├─ session-log.mjs    # 多帧 zstd 解码 + 会话日志读取
├─ inspect-session.mjs # 解压会话日志、统计事件类型（排查用）
└─ asar-read.mjs      # 从 app.asar 里读任意文件（核对桌面版真实类型）
```

## 跑起来

**1. 先验证纯逻辑（不需要 dsh）**

```sh
pnpm install      # 装 @deepseek-ai/dsh-tools@0.2.1-rc.2 和类型
pnpm build        # tsc → dist/
pnpm test         # 冒烟 41 项 + 端到端 24 项
```

冒烟测试直接测 `dist/`——也就是 dsh 真正加载的那份 JS，41 项断言：事实派生（文件/命令/待办合并/标题）、结论合并、L0 预算裁剪、refs 解析、注入消息形状、工作区 key 稳定性、上下文窗口解析。

`mock-run.mjs` 用假 ctx 真的调用 `apply()`：注册工具、触发 `agent/created(startup)`、检查注入内容、验证 `resume`/subagent 跳过、`recall_context` 分节、80% 只报一次 + 自动落纯事实包。全程 `DSH_HOME` 指向临时目录，不碰真实 `~/.dsh`。

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

插件自带 `@deepseek-ai/dsh-tools@0.2.1-rc.2`（与桌面版 0.2.1-rc.2 对齐），所以放在任何目录都能解析，不用挪进 dsh 仓库。

**3. 用一遍**

1. 聊几轮 → 让模型调 `handoff_save`，**记得传 `summary` / `nextStep` / `openQuestions` / `refs`**（或 `/handoff <一句话结论>`）
2. 检查 `~/.dsh/handoff/<workspace-key>/latest.json`（`<workspace-key>` 是工作区真实路径的 sha1 前 12 位）
3. 开新会话 → 首条消息发出去后，会话开头应出现交接摘要
4. 问模型"上次改了哪些文件" → 它应该调 `recall_context(section="files")`

## 与 dsh 类型的对接

`src/compat.ts` 是唯一直接对接 dsh 类型的文件，内容全部按官方 `.d.ts` 写（dsh `0.2.1-rc.2`），不是猜的：

| 对接点 | 来源 | 确认方式 |
|---|---|---|
| `UserMessage` / `MessageSourceMap` | `@deepseek-ai/dsh-llm/message` | 声明合并新增 `handoff` kind（官方说明这是扩展点） |
| `Session` / `SessionEvent` | `@deepseek-ai/dsh-session` | `session/event(session, event)` |
| `Agent` / `AgentRegistry` | `@deepseek-ai/dsh-agent` | `inject(message)`、`ctx.agents.get(id)`、`currentInitiator()` |
| `agent/created` | `@deepseek-ai/dsh-agent` | 载荷 `{ agent, source: 'startup' \| 'resume' \| 'clear' \| 'compact' }` |
| `tokenMeter.measure` | `@deepseek-ai/dsh-token-meter` | `measure(session): TokenMeasurement`，含 `totalTokens` |
| `defineTool` / `ctx.tools.register` | `@deepseek-ai/dsh-tools` | 编译期校验 |

只有 `registerCommand` 仍是形状探测：`@deepseek-ai/dsh-commands` 在 npm 上只发布到 `0.0.1-rc.1`，与 `0.2.1-rc.2` 对不上。两种调用形式都试，失败就静默降级——用 `handoff_save` 工具触发同样能生成交接包。

## 版本对齐

插件把 `@deepseek-ai/dsh-tools` 作为自己的依赖固定成 `0.2.1-rc.2`，和桌面版当前版本一致。dsh 升级后要同步改这个版本号再 `pnpm install`，否则 `defineTool` 产出的对象可能对不上新的 `ToolDefinition` 形状。

## 已知边界

- **注入不唤醒 driver。** `agent.inject()` 只是排进 `next-step`，要等用户第一条消息唤醒才被 claim。这是刻意的：自动 `followup()` 会烧一次用户没要求的请求。
- **`resume` / `clear` / `compact` 不注入**，只对 `source === 'startup'` 生效，避免同一份摘要被反复塞进上下文。
- **子会话不注入。** `header.origin === 'subagent'` 或 `delegationDepth > 0` 的会话会跳过，否则每个 subagent 都会白背一份父会话摘要。
- **阈值必须早于 compaction。** 默认 60%/80%。窗口不是写死的：插件用 `ctx.llm.resolveModelInfo(provider, model)` 读适配器声明的 `contextWindow`，读不到才退回 1,000,000，并在日志里打印实际取到的值。想强制指定就设 `DSH_HANDOFF_WINDOW`。
- **结论只能由模型补。** 事件日志能派生文件、命令、待办、标题、规模，但派生不出"为什么这么做"。`handoff_save` 不传 `summary` 时会在返回值里明确警告，L0 里也只会出现事实性活动统计。
- **80% 会自动落一份纯事实包**，防止模型没来得及交接就断了。它不会覆盖本会话已经存过的包（那多半带模型结论）。
- **相对 `refs` 会先按 workspace、再按项目根解析。** 项目根从改动最多的文件推公共目录——用户常在家目录开会话去改 `D:` 上的仓库，光看 workspace 会解析错。
- pack 存在 `~/.dsh/handoff/<workspace-key>/`（不写进用户项目），保留最近 20 份，可手动编辑。`<workspace-key>` 由工作区真实路径的 sha1 前 12 位算出，所以同一项目经软链接或盘符大小写变化仍指向同一目录。

## 下一步路线

1. `progress` / `nextStep` 增加可选的 `ctx.llm.stream()` 一次结构化摘要（模型没传 brief 时才用，其余字段不动）
2. 压力提示接到 Web UI（状态栏圆环），可参考 `deepseek-harness-compaction-ui` 的落点
3. 跨工作区接力：pack 里带 git remote + branch，换机器也能接
4. `handoff_save` 支持 `--to <session>`，把摘要投递给正在运行的另一个会话

## 生态里已有的两个同方向插件

- `billion-context-dsh` — ACP 式压缩，替换 compaction 后端，压缩后仍可 `decompress` / `search_context`。它的 L2 检索思路可以直接复用。
- `deepseek-harness-compaction-ui` — 给官方压缩做阈值配置卡片和进度圆环。

两者都做**会话内**，本插件做**会话间**，可共存。
