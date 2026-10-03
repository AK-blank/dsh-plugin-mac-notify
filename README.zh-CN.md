# dsh-plugin-mac-notify

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 会话发
macOS 系统通知——无人值守跑任务时，把使用者叫回机器前。

```
┌──────────────────────────────────────────────┐
│ DSH · 任务完成                                │
│ browser_dsh                                  │
│ 插件已经写好并装好了，自检 57 项全过。        │
└──────────────────────────────────────────────┘
        ↑ 点击 → 直接切回已经开着 DSH 的那个浏览器标签页
```

纯 Host 侧 bundle：订阅 Host 事件并调用系统通知器。没有浏览器半边，所以页面里
不渲染任何东西，也不涉及刷新页面。

## 什么时候通知

| Host 事件 | 时机 | 横幅 |
|---|---|---|
| `agent/status` → `idle` | 一轮结束（`running` → `idle` 跃迁） | `DSH · 任务完成`，正文是最后一条助手回复 |
| `user-questions/request` | Agent 调用 `ask_user_question` 卡住等你回答 | `DSH · 需要你的回答`，正文含标题 · 问题 · 选项 |
| `approval/request` | Agent 在等你批准 | `DSH · 需要你的批准`，正文是原因或工具名 |
| `agent/error` | 某步或某轮报错 | `DSH · 执行出错`；随后的结束横幅显示 `任务结束（有报错）` |

子 Agent 默认不打扰（`includeSubagents: false`）；5 秒内内容相同的横幅合并成一条；
普通横幅之间还有最小间隔——但「需要回答 / 需要批准」永远不被间隔吃掉。

## 依赖

- macOS。其它平台插件照常激活，只打一行 debug 日志，不发送任何东西。
- 可点击跳转需要 [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
  （`brew install terminal-notifier`）。没装时自动退回 macOS 自带的 `osascript`
  横幅：文案和声音一样，只是点击没有动作。

较新的 macOS 上，ad-hoc 签名的通知器必须手动授权一次才能发通知：
**系统设置 → 通知 → terminal-notifier → 允许通知**（样式选「横幅」，打开「播放通知声音」）。
在此之前 `terminal-notifier -diagnose` 会显示 `authorization: not requested yet`，
发送会返回 `Notifications are not allowed for this application`。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-plugin-mac-notify   # 本地目录
dsh plugin --profile web add github:<owner>/dsh-plugin-mac-notify
```

包声明了 `dsh.bundle.patch`，所以 profile 会把它记进 `dsh.profile.bundles`，
下一次 reconcile 时套用该层，插件也会出现在 GUI「插件」页里（带开关和卸载）。
零依赖、无安装脚本、无构建步骤。

### 升级需要重启

DSH 对宿主侧模块代码是按进程缓存的：替换包、重新安装、甚至把行关掉再打开，
跑的都还是上一代模块。升级后要重启 `dsh web`（或 `dsh tui`）才会加载新代码。
浏览器半边恰好相反——只需刷新页面。

DSH 没有插件自动更新：升级 = `dsh plugin remove` 再 `dsh plugin add`。

## 配置

bundle 行本身不带 `config`，因此默认值生效。需要在 profile 自己的
`cordis.patch.yml` 里覆盖（该层在所有 bundle 层之后应用）：

```yaml
- id: mac-notify
  name: 'dsh-plugin-mac-notify'
  config:
    sound: Ping
    notifyOnApproval: false
    url: 'http://127.0.0.1:3080'
```

| 配置项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifyOnFinish` | `true` | 一轮结束 |
| `notifyOnQuestion` | `true` | 等你回答 |
| `notifyOnApproval` | `true` | 等你批准 |
| `notifyOnError` | `true` | 出错 |
| `includeSubagents` | `false` | 子 Agent 也通知 |
| `sound` | `'default'` | `'default'` = 你的系统提示音（读 `com.apple.sound.beep.sound`）；`/System/Library/Sounds` 里的名字（`Ping`、`Glass`、`Hero`…）；`'off'` = 静音 |
| `onClick` | `'focus'` | `'focus'` = 聚焦已有 DSH 标签页，找不到才打开；`'open'` = 总是打开；`'none'` = 点击无动作 |
| `notifier` | `'auto'` | `'auto'` 优先 terminal-notifier，`'osascript'` 强制用自带横幅 |
| `url` | `''` | 点击目标；留空表示自动探测（见下） |
| `language` | `'auto'` | `'auto'` 跟随 `LANG`/系统语言，也可固定 `'zh'` / `'en'` |
| `titlePrefix` | `'DSH'` | 横幅标题前缀 |
| `minIntervalMs` | `1500` | 普通横幅之间的最小间隔 |
| `bodyMaxChars` | `200` | 正文长度上限 |

### 点击目标怎么定

优先 `url`，其次本 Host 实际服务 Web UI 的端口（`ctx.get('webServer').port`），
再次环境变量 `DSH_WEB_URL`——所以换了端口也不用改配置。

点击时执行 `lib/click.mjs`：它用 `pgrep` 找出**正在运行**的浏览器（Chrome、Edge、
Brave、Vivaldi、Chromium、Safari——不会为了探测而启动浏览器），逐个询问是否有窗口
开着 URL 以目标开头的标签页；命中就把该标签页设为活动标签并置顶窗口。只有没有任何
运行中的浏览器开着它时，才回退到 `/usr/bin/open <url>`。

读取别的应用的标签页需要 macOS「自动化」权限，系统会在首次点击时按浏览器弹窗询问
（在「terminal-notifier 想要控制 …」上点允许）。拒绝也不影响可用性：脚本会回退到
`open`，只是变成新开一个标签页而不是复用原有的。

## 排查

两个开关都是发送时读取的环境变量——设在启动 DSH 的那个进程上：

```bash
DSH_MAC_NOTIFY_DRY_RUN=1 dsh web     # 只做决策，不启动任何进程
DSH_MAC_NOTIFY_LOG=/tmp/dsh-notify.jsonl dsh web
```

JSONL 轨迹每条记录一件事：`deliver`、`skip`（带 `reason`：`disabled` /
`duplicate` / `paced`）、`failure`、`sound-failed`，并包含选中的后端与点击模式。

- **完全没有横幅** → 看 `DSH_MAC_NOTIFY_LOG`；macOS 上再看 `terminal-notifier -diagnose`。
- **有横幅没声音** → 插件把你的系统提示音挂在横幅上，所以通常是系统输出音量，
  或系统设置里该通知器的「播放通知声音」没开。
- **点击没反应** → 点击动作只存在于 terminal-notifier 后端，`osascript` 横幅没有。
  看日志里的 `click: "focus"` 还是 `"none"`。
- **点击新开了标签页** → 该浏览器的自动化权限被拒，或没有运行中的浏览器开着该页面
  （此时脚本走 `open`）。

## 自检

```bash
node selftest.mjs      # 57 项断言，不发通知、不出声、不碰浏览器
```

自检驱动的是 Harness 实际加载的同一个 `lib/index.js`，把 `exec`、`exists` 和时钟
换成桩：覆盖打包契约（manifest、patch、locale、icon、零依赖的兼容性规则）、纯函数
（配置归一化、文案、argv 构造、解析器）、注册契约（`apply` 订阅了哪些事件）以及
事件驱动行为（每种 Host 事件实际发出什么、限流、去重、子 Agent 过滤、声音策略、
后端回退、dry-run 与轨迹）。还会通过真实的 `/bin/sh` 证明点击命令的引号能往返。

## 文件结构

```
lib/index.js     Cordis 插件：apply + 可注入的 runtime
lib/click.mjs    点击处理：先聚焦已有标签页，否则打开 URL
cordis.patch.yml bundle patch（一行 insert）
locale/*.json    「插件」页显示用的标题/描述
icon.svg         包图标
selftest.mjs     离线断言
```

## 安全说明

- 通知文本以 **argv** 传给通知器，绝不拼进 AppleScript 源码，所以会话里的一行文本
  不可能变成被执行的脚本。
- 点击命令由 `process.execPath`、包内 helper 路径和解析出的 URL 组成，各自经过
  单引号转义以适配运行它的 shell。
- 插件通过 `ctx.get(...)` 读取 `agent`/`session` 状态，服务缺失或受限时只会退化成
  「副标题里没有工作区名」，不会报错；每个监听器都有包裹，通知失败永远不会打断
  Host 的事件分发。

## 为什么每个监听器都是 global 的

Agent 事件带 scope carrier 分发，Cordis 只在
`hook.global || !filter || filter(carrier, hook.ctx)` 成立时才保留一个监听器。
因此，通过带 scope 标签的上下文注册的监听器只能收到那一个 Agent 的事件——
而从某个 Agent 的 scope 内部激活的行（用插件管理工具安装时就是这样）恰好会带上
那个标签。用 `{ global: true }` 注册可以跳出这个过滤，让一个插件覆盖进程内的所有 Agent。

这不是纸上推演：早先的版本用普通监听器注册，结果只对安装它的那个会话发通知。
`selftest.mjs` 现在会对每一个注册断言这个标志，防止回归。

## 社区目录

[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（同时也是 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 与 dsh-market 的数据源）
的收录条目已备好，在
[`contrib/AK-blank__dsh-plugin-mac-notify.yml`](contrib/AK-blank__dsh-plugin-mac-notify.yml)。
提交方式：fork 该列表，把这个文件复制成
`data/plugins/AK-blank__dsh-plugin-mac-notify.yml` 并开 PR——它的 CI 要求仓库创建满
一天；在此之前，本仓库已带的 `dsh-plugin` topic 会让 `dsh-plugin-radar` 先自动索引到。

`scripts/submit-catalog.mjs` 不用本地 clone 就能完成同样的事：把列表的 fork 与
upstream `main` 同步、在独立分支上加那一个文件、开 PR。它幂等（第二次运行只报告
已开的 PR）、在仓库未满年龄门槛时拒绝执行（退出码 3），且从不 force-push、不碰已有 PR。

```bash
node scripts/submit-catalog.mjs --dry-run   # 只校验条目，不写任何东西
node scripts/submit-catalog.mjs             # fork、建分支、提交、开 PR
```

## 许可

MIT

**非官方插件。** 与 DeepSeek 无从属、背书或支持关系。「DeepSeek Harness」是 DeepSeek 的
商标；本项目按官方品牌指南的建议，在生态内使用缩写「DSH」。
