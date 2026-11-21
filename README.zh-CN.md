# dsh-im-cron

[English](README.md) | **简体中文**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件**，给 [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im) 补上「定时」这一层 —— 在聊天里用一句自然语言创建定时任务，到点执行，结果推回**同一个聊天**。

> It is a companion plugin for dsh-im, not a standalone IM channel.

## 截图

| QQ 里创建并执行一个 `agent` 定时任务 | 在聊天里 `imcron_list` |
|---|---|
| <img src="https://raw.githubusercontent.com/mashago/dsh-im-cron/master/docs/screenshots/qq-scheduled-agent-task.jpg" width="340" alt="QQ 聊天：用户说 1 分钟后用 top 看看 CPU 内存占用，机器人确认排期并在到点后回复报告"> | <img src="https://raw.githubusercontent.com/mashago/dsh-im-cron/master/docs/screenshots/qq-task-list.jpg" width="340" alt="QQ 聊天：用户说列出定时任务，机器人用表格按 notify / command / agent 列出任务"> |

---

## ⚠️ 先读这个：它依赖 dsh-im

本插件**不连 QQ、不发消息、不管理会话**。它只做"什么时候跑、跑什么、把结果交给谁"。

| 层 | 谁负责 |
|---|---|
| IM 渠道：QQ 连接、会话绑定、主动发送、目标管理 | **dsh-im** |
| 定时：排期、执行、取结果、记账 | **本插件** |

投递通过 dsh-im 暴露的 `dshIm` 服务（`contractVersion: 1`）完成，本插件**不 import dsh-im 的任何代码**，
只按服务契约调用 `send` / `describeConversation` / `resolveTarget`。

**没装 dsh-im 时**：任务照样能建、能执行、能记 `runs.jsonl`，但**没有投递通道** ——
启动日志会显示 `delivery=pending`，每次运行的 `deliver.status` 记 `skipped`。

```text
你（QQ）：每天早上 9 点提醒我写日报
机器人：已建好 imc-98c61823，下次 11-23 09:00

—— 第二天 09:00 ——
机器人：写日报 ✍️
```

---

## 为什么需要它

DSH 自带的 `schedule_*` 把定时任务跑在**会话**里，答案是否推回聊天取决于部署开关
`deliverModelAnswers`（默认关闭）。所以「到点发一句提醒」在原生调度下**默认静默**。

dsh-im 解决了「怎么把消息发到 QQ」，但没有定时器；本插件补的就是这一层，并把三件事拆开：

| 关心什么 | 谁负责 |
|---|---|
| **什么时候跑** | 本插件的调度器（毫秒级，见[调度精度](#调度精度)） |
| **在哪跑** | 任务专用会话（`agent` 载荷），不绑定聊天 |
| **发给谁** | dsh-im 的 `botId + targetId`，与 session 解耦 → 用户 `/new` 不影响投递 |

---

## 三种载荷

| 载荷 | 到点做什么 | 模型成本 |
|---|---|---|
| `notify` | 发一条固定文本 | **0** |
| `command` | spawn 一个脚本，stdout 回推 | **0** |
| `agent` | 在任务专用会话里跑**一个** agent 回合，答案回推 | 1 回合 |

`notify` / `command` 全程不经过模型 —— 没有"让模型在宿主上执行任意命令"的通道。
`agent` 只有**执行**经过一次模型，**投递**仍然零模型。

---

## 要求

| 项 | 必需 | 版本 |
|---|---|---|
| Node.js | ✅ | `>= 24.9.0`（与 DSH 一致） |
| DeepSeek Harness | ✅ | `0.2.2-rc.x` |
| **[`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im)** | **✅ 投递必需** | `5.10.0`（已按此版本验过 `dshIm` 契约） |
| 平台 | — | macOS 已实测；Linux 预期可用但未实测；Windows 分支（`cmd.exe`）仅静态检查 |

---

## 安装

**① 先装并配好 dsh-im**（QQ 机器人 + 接收目标），确认它能正常收发消息：

```bash
dsh plugin --profile web add @xmanrui/dsh-im
```

**② 再装本插件**：

```bash
# 从 npm
dsh plugin --profile web add dsh-im-cron

# 或指向本地目录 / tarball
dsh plugin --profile web add /path/to/dsh-im-cron
```

两者必须装在**同一个 DSH 实例、同一个 profile** 里 —— 本插件通过 `ctx.get('dshIm')` 找它。

装完确认两行已插入 profile：

```bash
dsh --profile web --dump-config | grep im-cron
```

启动日志应出现：

```text
[im-cron] delivery=dshIm agent=on jobs=N stateDir=~/.dsh/im-cron
```

`delivery=pending` 表示启动时没探测到 dsh-im（之后每次使用都会重试探测）：`notify` / `command` 仍会执行，只是不投递。

> **主插件配置（`im-cron` 行：`timezone`、`scriptDir`、`activeHours`、`jobs` 等）改后需要重启 DSH**，
> 它在启动时读取。插件页里的「agent 任务会话」设置是例外：保存后下一次 agent 任务执行即生效。

---

## 快速开始

在聊天里说：

| 你说 | 建的载荷 |
|---|---|
| 「1 分钟后提醒我开会」 | `notify` + `at` |
| 「每天早上 9 点提醒我写日报」 | `notify` + `cron` |
| 「1 分钟后跑 stock-report.sh，跑完告诉我」 | `command` + `at` |
| 「每天 15:30 跑收盘脚本，不用通知我」 | `command` + `cron` + `notify:never` |
| 「每天 9 点帮我汇总财经新闻」 | `agent` + `cron` |
| 「每 2 分钟查一次进程，跑 3 次就停」 | `agent` + `every{minute,2}` + `maxRuns:3` |

脚本载荷需要先把脚本放进[脚本目录](#脚本载荷)。

---

## 工具

9 个工具，全部在全局行 `im-cron-tools` 注册，任何 agent 都能看到。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `imcron_remind` | 到点发固定文本 | `text`、`at`/`cron`/`every`、`timezone?`、`maxRuns?` |
| `imcron_run` | 到点 spawn 脚本 | `script`、`timeoutSeconds?`、排期、`notify?`、`maxRuns?` |
| `imcron_ask` | 到点跑一回合 | `prompt`、排期、`notify?`（`always`/`never`）、`timeoutSeconds?`、`maxRuns?` |
| `imcron_list` | 本聊天的任务、下次运行、上次结果 | — |
| `imcron_update` | 改排期 / 文案 / `notify` / `maxRuns` | `id` + 上述字段 |
| `imcron_remove` | 删任务（**不删投递目标**） | `id` |
| `imcron_pause` / `imcron_resume` | 暂停 / 恢复 | `id` |
| `imcron_trigger` | 立即执行一次，不改排期与水位 | `id` |

行为约定：

- 创建工具返回 `{ id, nextRunAt, next3 }`；`next3` 让用户当场确认"是不是这个点"。
- `imcron_update` 只改排期 / 文案 / `notify` / `maxRuns`；**载荷类型和目标不可改**，要换就删了重建。
- 改排期会**重新锚定**，旧排期的槽不会再触发。
- `imcron_list` **不返回 `sessionId`**（对"我有哪些任务"没用，还会被念成噪音）。任务会话 id 只在 CLI `--verbose` 和 `runs.jsonl` 里。
- 目标隔离：模型**不能**指定 bot 或聊天，只能从当前会话反查；管理工具看不到别的聊天的任务（别人的 id 与"不存在"返回同一个错误）。
- `imcron_list` 区分三态：**启用** / **暂停** / **已结束**。

### 原生 `schedule_*` 在 IM 会话里被禁用

三层，只有最后一层是强制的：

| 层 | 机制 |
|---|---|
| 提示层 | 系统提示段 `tool:imcron`（**只对 IM 会话生效**，按会话 id 过滤） |
| 可见层 | `agent/created` → `tools.restrict({deny:['schedule_create','schedule_edit','schedule_list','schedule_view']})` |
| **执行层** | `tools/execute` 守卫命中即返回 `isError`，工具体不执行 |

原因：原生定时任务的回答默认不推送，而模型实测会优先点它。
**Web / 桌面会话完全不受影响**，`schedule_*` 在那里照常可用。

---

## 时间表达式

三种，**互斥**，按语义选：

```jsonc
// 一次性
{ "at": "2026-11-21T09:00:00+08:00" }
{ "at": { "date": "2026-11-21", "time": "09:00", "timezone": "Asia/Shanghai" } }

// 墙上时钟规律（5 段）
{ "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" }   // 工作日 9 点
{ "cron": "0 9,18 * * *" }                               // 每天 9 点和 18 点
{ "cron": "0 9 1 * *" }                                  // 每月 1 号
{ "cron": "0 9 L * *" }                                  // 每月最后一天

// 间隔
{ "every": { "unit": "minute", "count": 90 } }                            // 每 90 分钟
{ "every": { "unit": "hour", "count": 3 } }                               // 从现在起每 3 小时
{ "every": { "unit": "day", "count": 15, "at": "06:00", "timezone": "Asia/Shanghai" } }
{ "every": { "unit": "week", "count": 2, "at": "10:00", "timezone": "Asia/Shanghai" } }
```

选哪个：

| 用户说的 | 用 |
|---|---|
| 某个时刻 / 某一天 | `at` |
| 工作日、一天多个时刻、每月某天、某个月 | **`cron`**（`every` 表达不了） |
| 每 N 分钟 / 小时 / 天 / 周 | `every` |

规则：

- `cron` 只接受 5 段；拒绝秒字段、宏（`@daily`）、"值 + 步长"（`0/15`）；支持 `L`（月末）。
- `cron` 写**本地墙上时间**，不要先换算成 UTC。
- `*/15` 是「每月 1、16、31 号」，**不是**「每隔 15 天」。要后者用 `every{day,15}`。
- `every` 的 `minute` / `hour` 是**瞬时制**：锚定创建时的整分，纯算术推进，跨 DST 间隔不变。
- `every` 的 `day` / `week` 按**本地日历**推进：跨 DST 保持墙上时间，缺口顺延、重叠取较早。
- `at` 必须严格未来；落在 DST 缺口的时刻直接拒绝。

> **首次触发的锚点**
> `every{day|week, at}` 从**第一个未来的 `at` 时刻**开始 —— 下午建的「每 15 天早上 6 点」
> 首次在**明天** 06:00，不是 15 天后。`minute` / `hour` 从创建时刻的整分起算。
> 创建时返回的 `next3` 就是用来核对这件事的。

---

## 配置

```yaml
- insert:
    - id: im-cron
      name: dsh-im-cron
      config:
        timezone: Asia/Shanghai
        scriptDir: ~/.dsh/im-cron/workspace
        activeHours: { start: '08:00', end: '22:00' }
        agent:
          enabled: true
          timeoutSeconds: 900
          permissionPreset: danger-full-access
        # 运维声明的任务（不经模型）
        jobs:
          - id: decl-close
            name: 收盘行情
            schedule: { cron: '30 15 * * 1-5', timezone: Asia/Shanghai }
            payload: { kind: command, script: stock-report.sh }
            deliver: always
            target: { botId: qq_xxxxxxxxxxxxxxxx, targetId: cron-0123456789ab }
```

| 键 | 默认 | 说明 |
|---|---|---|
| `channel` | `dshIm` | 渠道标识（当前仅 dsh-im） |
| `requireChannel` | `true` | 探测不到 dsh-im 时拒绝创建需要投递的任务 |
| `stateDir` | `$DSH_HOME/im-cron` | 状态目录 |
| `scriptDir` | `<stateDir>/workspace` | 脚本目录，见[脚本载荷](#脚本载荷)。**插件不创建它** |
| `timezone` | 宿主时区 | 排期解析 / 展示的默认时区 |
| `pollSeconds` | `30` | **兜底扫描**间隔（不是触发精度，见[调度精度](#调度精度)） |
| `activeHours` | 空（全天） | 执行时间窗 `{start, end, timezone?}` |
| `catchUp` | `none` | 停机期间错过的时间槽：`none` 跳过 / `once` 补一次 |
| `defaultTimeoutSeconds` | `600` | 脚本默认超时 |
| `endedRetentionHours` | `24` | 一次性任务结束后保留多久；`0` = 不清理 |
| `maxNotifyChars` | `2000` | 提醒文本上限（创建时校验） |
| `maxJobs` / `maxJobsPerTarget` | `500` / `50` | 任务容量上限 |
| `allowChannels` | `['qq']` | 允许创建任务的渠道 |
| `allowGroup` | `true` | 是否允许群聊建任务（**群聊里脚本载荷一律禁用**） |
| `jobs` | `[]` | 声明式任务，启动时按 id upsert（保留既有水位） |
| `agent.enabled` | `true` | 探测不到 `sessionController` 时自动只禁用 `agent` 载荷 |
| `agent.timeoutSeconds` | `900` | agent 回合的**软截止** |
| `agent.stuckGraceSeconds` | 空（软截止 × 2） | agent 回合的**硬截止** |
| `agent.maxConcurrent` | `2` | 同时运行的 agent 回合上限 |
| `agent.permissionPreset` | 空 | 任务会话的权限档，见[权限档](#权限档) |
| `agent.taskSessionMaxAgeDays` | `30` | 任务会话超过这个天数换新 |
| `agent.attachWorkspace` | `false` | 任务会话是否挂进 workspace |
| `agent.echoToChat` | `false` | 跑完是否把摘要 inject 回聊天会话 |

`activeHours` 细节：

- 窗口外的槽**直接跳过、不补跑**（提醒错过窗口就是过期信息）。
- `end` 可写 `24:00`；`start > end` 表示跨夜（如 `22:00`–`06:00`）。
- `start === end` 等于**关闭所有槽**。
- 时区非法时只 warn 并**不限制**，不会静默吞掉所有任务。

---

## 脚本载荷

`imcron_run` 只接受**一个已存在的可执行文件**，不接受 shell 字符串。

```bash
mkdir -p ~/.dsh/im-cron/workspace
cat > ~/.dsh/im-cron/workspace/stock-report.sh <<'EOF'
#!/bin/sh
echo "报告生成于 $(date '+%F %T %Z')"
EOF
chmod +x ~/.dsh/im-cron/workspace/stock-report.sh
```

脚本必须满足三条：

1. 位于 `scriptDir` 内（相对名或绝对路径都行，**解析后必须仍在目录内**）
2. 是普通文件
3. 有执行权限，且首行有 shebang

拒绝的四种情况：

| 错误码 | 触发条件 |
|---|---|
| `script-dir-missing` | `scriptDir` 不存在 |
| `script-not-found` | 文件不存在 |
| `script-outside-dir` | `realpath` 解析后跑出目录（含 `../` 与符号链接） |
| `script-not-executable` | 没有执行权限 |
| `command-not-allowed-in-group` | 在群聊里创建脚本任务 |

运行约定：

| 项 | 值 |
|---|---|
| cwd | `scriptDir` |
| 环境变量 | `IMCRON_JOB`、`IMCRON_OCCURRENCE` |
| 超时 | 任务 `timeoutSeconds`，否则 `defaultTimeoutSeconds` |
| 成功判定 | exit 0 |
| 投递内容 | stdout；stdout 为空则 stderr；失败时带 exit 码 + stderr 尾部 15 行 |

---

## 投递策略

三态：

| `deliver` | 成功 | 失败 |
|---|---|---|
| `always` | 发结果；结果为空则发 `✅ <任务> 完成（无输出）` | 发 `⚠️ <任务> failed` + 摘要 |
| `on-failure` | 不发 | 同上 |
| `never` | 不发 | 不发（只写 `runs.jsonl`） |

默认值：`notify` → `always`，`command` → `on-failure`，`agent` → `always`。

**错误策略**（dsh-im 不返回 `retryable`，下表就是判定依据）：

| 错误码 | 处理 |
|---|---|
| `bot-not-connected`、`cancelled`、服务未就绪 | 留 `pending`，退避重试 |
| `delivery-failed` / `send-result-unknown` | **不重试**（markdown 分片可能"已发出、结果未知"，重发就是重复消息），最多换纯文本再发一次 |
| `unknown-bot` / `unknown-target` | 任务标 `needs-rebind`，告警一次 |
| `invalid-target` / `bad-request` / `capability-unavailable` 等 | 记 `failed`，不重试 |

---

## 调度精度

两级机制：

| 机制 | 作用 | 精度 |
|---|---|---|
| **截止点定时器** | 指向所有可运行任务里最近的 `nextDue`，到点直接触发 | 毫秒级 |
| **兜底扫描**（`pollSeconds`） | 笔记本休眠、系统时间跳变、定时器失效时补跑 | ≤ `pollSeconds` |

**定时器是优化，扫描是保证** —— 前者失效只是退化成轮询，不会丢任务。
超过 6 小时的等待会分片重算（`setTimeout` 溢出保护），顺带处理 DST。

实测偏差：同一批任务 **9–38 ms**（多数 10 ms 量级）。

---

## `agent` 载荷

- 一条任务一个**任务专用会话**：首跑 `sessionController.create({cwd, agentPreset})`（配了模型路由再 `selectModel`），之后 `resolveAgent` 复用。cwd 默认是插件状态目录（`$DSH_HOME/im-cron`）；要换目录就在 agent 任务会话设置里填 `cwd`。
- 会话**不绑定聊天** → 渠道不会镜像它 → 答案只在插件 `send` 时出现**一次**，没有双推。
- 回合归属靠我们那条 `followup` 的 message id：`turn/start` 只带 `{turn}`，`user/message` 命中我们的 id 才认领，`turn/end` 同 turn 收尾。
- **两段式超时**：软截止到点只记日志、继续等；硬截止仍未结束才 `cancel({kind:'user'})` 并记 `failed/stuck`。软硬之间完成的回合照常投递真实答案。
- 并发：`agent.maxConcurrent`，等待超过 `2 × pollSeconds` 记 `skipped: busy`；同一任务上一轮没结束则 `skipped: running`。
- 自愈：`session/not-found` → 重建；`turn/end` 为 `blocked`（会话被归档）→ 丢会话、下一轮重建。
- 会话标题写成 `⏰ <任务名>`，可在侧栏找到（用户手动改过的标题不会被覆盖）。

### 权限档

`agent.permissionPreset` 只作用于**任务会话**（写该会话自己的日志），不影响聊天或 Web 会话。

| 值 | sandbox | approval | 后果 |
|---|---|---|---|
| 留空 | 部署默认（`workspace-write` + `ask`） | | 需要审批的调用会**挂到超时**（见[已知限制](#已知限制)） |
| `workspace-write` | 工作区内可写 | `ask` | 同上 |
| `danger-full-access` | 全开 | `never` | 无沙箱、不审批；`ps` / `top` 等 setuid 程序可执行 |

等价的手写配置：

```yaml
- id: im-cron-agent
  name: dsh-im-cron/agent-settings
  config:
    cwd: ~/.dsh/im-cron
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low
    permissionPreset: danger-full-access
```

也可以在 **Web → 插件 → dsh-im-cron → agent 任务会话** 里改。**保存后下一次 agent 任务执行即生效**
（字段是 Loader 的 volatile 配置，`agent-turn.js` 每轮重新读取；改动会触发该任务重建会话）。
通知 / 脚本载荷不受这些设置影响。

---

## 执行次数上限

建任务时可选 `maxRuns`（1–10000）：跑满 N 次后自动标记结束。

- **只计计划执行**：`imcron_trigger` 手工触发不消耗次数
- 被中断的执行（进程重启）**计入**次数
- `imcron_update` 改 `maxRuns` 会把计数重置为 0
- `imcron_list` 显示进度：`已跑 2/3`

---

## CLI

```bash
node cli.js doctor                       # 状态目录、任务计数、脚本目录、最后一条运行
node cli.js list [--verbose]             # 任务、下次运行、上次结果（--verbose 带 sessionId）
node cli.js run <id> [--config cfg.json]  # 立即执行一次（CLI 无通道，投递记 skipped）
node cli.js log [--job <id>] [-n 50]     # runs.jsonl 尾部
```

通用参数 `--state-dir DIR`（默认 `$DSH_HOME/im-cron`）。

---

## 状态与文件

```
$DSH_HOME/im-cron/
  state.json              { version: 1, jobs: [...] }
  state.json.bak          上一次写入前的副本
  runs.jsonl              运行记录，一行一条
  workspace/              脚本目录（默认值，需手动创建）
```

- 写入是 `tmp → fsync → rename`。
- `state.json` 损坏时复制成 `state.json.corrupt-<时间戳>`，**按空状态启动**，DSH 不受影响。
- `runs.jsonl` 字段：`at`、`jobId`、`mode`、`occurrence`、`trigger`、`durationMs`、`result{kind,exit?,reason?}`、`deliver{status,attempts?,error?}`、`sessionId?`、`turn?`、`textTail?`。

### 幂等

对任意 `(jobId, occurrence)`，**磁盘状态只允许启动一次执行**：

1. 执行前把占位（`lastFiredFor` + `endedAt` + `inflight`）fsync 到 `state.json`
2. 占位落盘失败则**本轮不执行**（宁可跳过，也不冒重复执行的风险）
3. 进程在执行中退出 → 启动时扫到残留 `inflight`，记一条 `result.kind=interrupted` 并清掉，**不重放**（at-most-once）

---

## 源码布局

```
index.js             插件装配：探测 dshIm / sessionController → 调度器 + 守卫 + 声明式任务
config.js            zod 校验 + 默认值
tools.js             9 个 imcron_* 工具（全局行 im-cron-tools）
agent-settings.js    Loader 行 im-cron-agent（Web 表单）
client.js            Plugins 页表单
diag.js              按需诊断日志

core/schedule.js     at / cron / every 解析、nextDue、DST 墙上时间引擎
core/scheduler.js    截止点定时器 + 兜底扫描、原子占位、崩溃恢复、activeHours、maxRuns
core/job.js          载荷分派 → 投递三态 → runs 记账
core/agent-turn.js   任务会话、回合归属、两段式超时、答案提取
core/scripts.js      脚本路径解析与目录越界校验
core/exec.js         进程 spawn、进程树、输出尾部
core/store.js        state.json 原子写、runs.jsonl、损坏隔离

channel/dsh-im.js    send / resolveTarget / describeTarget / describeConversation(+Sync)
cli.js               doctor / list / run / log
examples/            示例配置与演示脚本
```

`channel/dsh-im.js` 是**唯一**跟 dsh-im 打交道的文件：换渠道只需换它，
`core/` 全部与渠道无关。

---

## 与 dsh-im 的契约

本插件只依赖 dsh-im 暴露的**服务方法**，不 import 它的代码、不读它的状态文件：

| 方法 | 用途 |
|---|---|
| `send(botId, targetId, text, { format })` | 主动发送，零 session / 零回合 / 零模型 |
| `describeConversation(sessionId)` | 会话 → `{channel, botId, chatType, chatId, senderId}`（建任务时定位目标） |
| `describeConversationSync(sessionId)` | 同上，内存快路径；路由守卫和提示作用域用它 |
| `listTargets(botId)` | 复用已保存的投递目标 |
| `createTarget(botId, {targetId, name, kind, route})` | 首次建目标（只接受这 4 个键） |

启动时会检查 `contractVersion >= 1`；缺任何一个方法就只禁用投递，插件本身照常加载。

**dsh-im 升级时先看这两件事**：`contractVersion` 有没有变、`send` 的参数形状有没有变。
适配层集中在 `channel/dsh-im.js` 一个文件里 —— 换渠道或跟进契约变化只改这里。

> 也支持在 profile 里手写两行代替 bundle 安装，见 `examples/config.yml`。

## 安全模型

| 面 | 控制 |
|---|---|
| 能跑什么（脚本） | 只能是 `scriptDir` 内的**已存在可执行文件**；不接受 shell 字符串；群聊里整体禁用 |
| 能跑什么（agent） | 只看任务会话的 preset 工具集；不改用户聊天会话；审批无人应答时挂到超时（见已知限制） |
| 能发给谁 | 目标只能由当前会话反查，**模型不能指定 bot / 聊天** |
| 能发多少 | `maxJobs`、`maxJobsPerTarget`、`maxNotifyChars`，创建时校验 |
| 能跑多少 | `agent.maxConcurrent`、同一任务单飞；`cron`/`every` 最小粒度 1 分钟（`at` 可到秒） |
| 审计 | 每次运行与投递写 `runs.jsonl`（不含凭据） |

---

## 故障排查

| 现象 | 先看 | 处理 |
|---|---|---|
| 到点没跑 | `cli.js list` 的 `下次`、`cli.js doctor` 的任务计数 | 确认 DSH 在跑、任务 `启用`。精度靠定时器，`pollSeconds` 只是兜底 |
| 跑了但没收到 | `runs.jsonl` 的 `deliver.status` / `error` | `bot-not-connected` 等重连；`unknown-target` → 任务转 `needs-rebind` |
| 模型说"建不了任务" | 聊天是否在 QQ、`allowGroup`、`allowChannels` | 工具只在 IM 会话里可用；Web 里会提示去 QQ |
| 模型没调 `imcron_*` | preset 是否屏蔽了工具 | 检查 profile / preset 的工具集 |
| agent 任务一直跳过 | `result.reason` | `running` = 上一轮没结束；`busy` = 超出 `maxConcurrent` |
| agent 报 `stuck` | 任务会话日志里的 `approval/asked` | 多半停在 `ask` 上无人应答；配 `danger-full-access` |
| 出现 `result.kind=interrupted` | 上一条同任务的 `inflight` | 进程在执行中退出；该槽**不重放**。一次性任务已标记结束，需要就**重新创建** |
| 任务里 `ps` / `top` 报 `Operation not permitted` | 任务会话的 `sandbox/mode` | `workspace-write` 不允许 exec setuid 程序；改用 `pgrep` / `lsof`，或配 `danger-full-access` |
| 脚本任务建不了 | `cli.js doctor` 的 `scriptDir` 行 | 目录不存在或脚本不在里面 / 没 `chmod +x` |

### 诊断日志

默认关闭。排查调度问题前在**启动 DSH 之前**设置环境变量：

```bash
IMCRON_DIAG=1 dsh web
IMCRON_DIAG=1 IMCRON_DIAG_FILE=/tmp/imcron-trace.log dsh web   # 改输出位置
```

JSON Lines，每行 `<ISO 时间> [<模块实例id>] <事件名> {<JSON>}`。
同一进程出现**两个不同的实例 id** 说明插件模块被加载了两份 —— 这是"配置不生效"的典型原因。
`npm test` 下永不写日志。

---

## 已知限制

- **`workspace-write` 下 `ps` / `top` / `sudo` 一律不可用。** 它们是 setuid 二进制，
  Seatbelt 沙箱不允许 exec setuid 程序，报 `Operation not permitted`。
  这不是审批能解决的 —— 只能 `danger-full-access` 解除沙箱，或改用 `pgrep` / `lsof` / `vm_stat` / `iostat`。
- **审批会挂住无人值守的回合。** 任务会话停在 `ask` 策略上时，只要有 Web GUI 在线（它注册了
  `approval/request` 应答者），请求会排进任务会话界面等人点，无人应答就等到软截止超时。
  只有**完全没有应答者**时才瞬时 fail-closed。无人值守请配 `danger-full-access`（`approval: never`）。
- 群聊主动消息可能被平台限流，失败记 `delivery-failed`，不自动重发（可能已发出）。
- 群聊**不支持脚本载荷**。
- CLI 没有投递通道，`cli.js run` 一律记 `deliver=skipped`。
- 任务会话出现在 Web 侧栏 **Ungrouped** 分组（标题 `⏰ <任务名>`）。
- 提醒文本上限在**创建时**校验；脚本 / 模型输出不设上限，由 dsh-im 按 4500 字分片。
- 同一任务的 agent 回合**单飞**：上一轮没跑完时本次记 `skipped: running`，所以"每分钟"实际是"每分钟最多一次"。
- 多实例并发共用同一 `stateDir` 时，幂等保证只在单进程内成立（启动时的 `recoverInterrupted` 会接管残留占位）。
- 渠道层目前只实现了 dsh-im；接其他渠道需要新写 `channel/*.js`（接口见源码布局）。
- Windows 分支（`cmd.exe`）只做了静态检查，未实测。

---

## 开发

```bash
npm install
npm test          # node --test，169 个用例
```

测试覆盖：时间表达式与 DST、调度器的原子占位 / 崩溃恢复 / `maxRuns` / `activeHours`、
三种载荷与投递三态、回合归属与超时、脚本路径校验、工具参数与文案。

---

## 许可证

[MIT](LICENSE)
