# 飞书 / Lark

> 派生自 [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) 的 `discord` channel 插件（Apache-2.0，见 [LICENSE](./LICENSE)）：结构、访问控制和安全措施沿用原版，收发层换成飞书开放平台，并加了"审批人"机制。

用一个 MCP server 把飞书（或 Lark 国际版）机器人接进 Claude Code。

机器人收到消息后，MCP server 把消息转给 Claude，并提供 `reply` 工具让 Claude 回复。发往群聊和他人的回复要先经审批人在私聊里点头才会发出。发来的图片（含富文本里夹的图）和文件会自动下载到本地，Claude 用 Read 查看。

## 前置条件

- [Bun](https://bun.sh) —— MCP server 跑在 Bun 上。安装：`curl -fsSL https://bun.sh/install | bash`。
- 一个飞书（或 Lark）企业 / 团队里创建自建应用的权限。

## 快速上手
> 默认是单人私聊 + 配对流程。群聊和多人设置见 [ACCESS.md](./ACCESS.md)。

**1. 创建自建应用。**

打开[飞书开放平台开发者后台](https://open.feishu.cn/app)（Lark 用 [open.larksuite.com/app](https://open.larksuite.com/app)），**创建企业自建应用**，起个名字。

在 **添加应用能力** 里加上 **机器人**。

**2. 开权限。**

**权限管理** 里开通（以后台实际名称为准）：

- 读取用户发给机器人的单聊消息（`im:message.p2p_msg:readonly`）
- 接收群聊中 @ 机器人消息事件（`im:message.group_at_msg:readonly`）
- 获取与发送单聊、群组消息（`im:message`）—— 发消息用；后台若有"以应用的身份发消息"（`im:message:send_as_bot`）也可，二者任一即可（以[发送消息 API 文档](https://open.feishu.cn/document/server-docs/im-v1/message/create)的权限要求为准）
- 获取单聊、群组消息（`im:message:readonly`）—— 收图片 / 文件用（下载消息里的资源）；不开时文字照常，图片 / 文件的占位后面显示"下载失败"。`im:message.history:readonly` 或 `im:message` 也能下载，任一即可
- 获取群组信息（`im:chat:readonly`）—— 审批消息里显示群名用，可选
- 获取通讯录基本信息（`contact:contact.base:readonly`）—— 显示发送人名字用，可选；没有就只显示 open_id。只对应用「通讯录权限范围」内的本组织成员有效，外部人员的名字拿不到

> 群里不 @ 也要响应（`--no-mention`）时，还需要"获取群组中所有消息"（`im:message.group_msg`），这是敏感权限，按需申请。

**3. 订阅事件（长连接）。**

**事件与回调 → 事件配置**：订阅方式选 **使用长连接接收事件**，添加事件 **接收消息 v2.0**（`im.message.receive_v1`）。长连接不需要公网地址，本机就能收事件。

**事件与回调 → 回调配置**：订阅方式选 **使用长连接接收回调**，添加回调 **卡片回传交互**（`card.action.trigger`）。审批卡片上的按钮靠它生效；没配的话按钮点了没反应（飞书会提示出错），仍可用文字命令审批。改完重新发版。

> 后台保存长连接方式时，可能要求应用此刻已经在线连着。可以先做完第 5–7 步把 session 跑起来，再回来保存。

**4. 发布版本。**

**版本管理与发布** 里创建版本、设置可用范围（谁能看到这个机器人）、提交发布。改了权限或事件后要重新发版才生效。

**5. 安装插件。**

以下是 Claude Code 里的命令 —— 先运行 `claude` 进入 session。

```
/plugin marketplace add taige/claude-utils
/plugin install feishu@claude-utils
```

**6. 把凭据交给 server。**

在开发者后台 **凭证与基础信息** 里拿 App ID 和 App Secret：

```
/feishu:configure cli_xxxxxxxx <app_secret>
/feishu:configure cli_xxxxxxxx <app_secret> lark     # Lark 国际版
```

写入 `~/.claude/channels/feishu/.env`（`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`）。也可以手写这个文件，或在 shell 环境里设这些变量 —— shell 优先。

> 同一台机器跑多个机器人（不同应用、各自的名单）时，给每个实例把 `FEISHU_STATE_DIR` 指到不同目录。状态目录默认跟着 `CLAUDE_CONFIG_DIR` 走：`$CLAUDE_CONFIG_DIR/channels/feishu`。

**7. 带 channel 参数重启。**

不带这个参数 server 不会连上 —— 退出 session 重新开。研究预览期间 channel 插件要在 Anthropic 的允许列表里才能用 `--channels`，自建 marketplace 的插件不在列表里，要用开发参数（启动时会弹一个确认框，选 "I am using this for local development"）：

```sh
FEISHU_CHANNEL=1 claude --dangerously-load-development-channels plugin:feishu@claude-utils
```

> **`FEISHU_CHANNEL=1` 不能省**：插件装在 user 级时，每个 Claude Code 会话都会起一份 server，而飞书把每条事件只推给该应用众多长连接里的一条——别的会话一连上就会把消息"抢走"然后丢掉。所以只有带 `FEISHU_CHANNEL=1` 启动的会话才连飞书，其他会话里插件不连接、`reply` 直接报错。同一个应用也不要同时开两个带 `FEISHU_CHANNEL=1` 的会话。

> Team / Enterprise 组织的管理员把本插件加进 `allowedChannelPlugins` 后，才可以改用 `claude --channels plugin:feishu@claude-utils`。

**权限模式与 `reply` 预放行。** 群里的消息来自他人，channel 会话用 `--permission-mode default`（不要用 auto：auto 下判断器会替你放行它认为安全的写操作，不弹确认、也就不会转到你的私聊），只预放行只读命令。另外把 `reply` 工具本身预放行——插件对发往群 / 他人的回复自带审批（卡片按钮），不放行的话每次回复会先弹一次工具权限确认、再来一张草稿卡片，审批两遍；夜里开了自动发送也会卡在这次工具确认上。在会话目录的 `.claude/settings.local.json` 里：

```json
{ "permissions": { "allow": ["mcp__plugin_feishu_feishu__reply"] } }
```

**收图片 / 文件要放行 inbox。** 下载的文件在状态目录的 `inbox/` 下（`~/.claude/channels/feishu/inbox`，状态目录是软链时取真实路径），不在会话目录里，Claude 用 Read 读时会弹权限确认。启动时用 `--add-dir` 把 inbox 的真实路径加进来：

```sh
INBOX="$(realpath ~/.claude/channels/feishu)/inbox"; mkdir -p -m 700 "$INBOX"
FEISHU_CHANNEL=1 claude --dangerously-load-development-channels plugin:feishu@claude-utils --add-dir "$INBOX"
```

（设了 `FEISHU_STATE_DIR` / `CLAUDE_CONFIG_DIR` 的，换成对应目录。）

- 只加 inbox，**不要** `--add-dir` 整个状态目录：状态目录里还有 `.env`（App Secret）和 `access.json`。restricted 模式下文件工具只能访问工作目录和 `--add-dir` 加进来的目录，只加 inbox 就碰不到它们。
- 不是 restricted 的会话，要防 Claude 读到 `.env` 时，自己在 settings 里 deny 状态目录，并把 inbox 留出来（不然图片 / 文件也读不了）。deny 规则怎么写、对软链路径是否生效，以 Claude Code 权限文档和实测为准。

**8. 配对，并把自己设为审批人。**

session 跑着的时候，在飞书里私聊你的机器人 —— 它会回一个配对码。机器人没反应就检查 session 是不是带了第 7 步的参数。在 Claude Code 里：

```
/feishu:access pair <code> --approver
```

之后你的私聊就会进到 Claude；`--approver` 让你同时成为审批人：Claude 的权限请求和发往群 / 他人的回复都会私聊给你，权限请求回 `yes <id>` / `no <id>`，回复草稿回 `ok <码>` 发送、`no <码> [理由]` 丢弃（`yes` 不能批准草稿）。

**9. 锁定。**

配对只是用来拿 ID 的。人都进来之后切到 `allowlist`，陌生人就收不到配对码了：在终端里自己敲 `/feishu:access policy allowlist`。

> `/feishu:access` 和 `/feishu:configure` 只能由你在终端里亲手输入，Claude 不能替你调用（skill 设了 `disable-model-invocation`）—— 这样飞书消息里的提示注入改不了访问控制。

**睡前可以开自动发送**：在和机器人的私聊里发 `auto`（8 小时）或 `auto 10h`，期间发往群和他人的回复不再等审批、直接发出（默认不抄送给你，要抄送在终端里 `/feishu:access set autoSendCopy true`）；`auto off` 关闭，`auto status` 查看。工具权限请求照旧要审批。详见 [ACCESS.md](./ACCESS.md) 的"自动发送（睡眠模式）"。

## 访问控制

DM 策略、群聊、mention 判定、审批人、回复审批、发送配置、skill 命令和 `access.json` 结构见 **[ACCESS.md](./ACCESS.md)**。

**备注名**：飞书接口给的名字不对（个人账号改名后仍返回旧名）或拿不到（外部人员）时，在终端里 `/feishu:access name <open_id> <显示名>` 配一个本地备注名（存 `access.json` 的 `displayNames`），之后 Claude 看到的发送人、审批里的私聊对象都用它，改了不用重启；`/feishu:access name <open_id>` 删除。

速查：ID 是飞书的 **open_id**（`ou_...`，按应用区分），群用 **chat_id**（`oc_...`）。默认策略 `pairing`。群按 chat_id 逐个开启；群里只有名单上的人能触发，陌生人 @ 机器人会被静默丢弃并记下来，`/feishu:access` 里能看到、手动放行。

## 给 Claude 的工具

| 工具 | 用途 |
| --- | --- |
| `reply` | 发消息到某个会话。参数 `chat_id` + `text`，可选 `reply_to`（message_id）引用回复。超长自动分块。发往审批人自己私聊以外的地方（群、其他人）时，先把草稿私聊给审批人，工具立即返回 `queued for approval (draft_ref …)`（审批码只发给审批人，Claude 看不到）；审批人回 `ok <码>` 才真正发出，回 `no <码> [理由]` 则丢弃，结果以 channel 事件通知 Claude。 |

v0 只有 `reply` 一个工具：没有表情回应、编辑消息、拉历史。图片 / 文件不用工具，收到即下载（见下）。

## 附件与非文本消息

文本（`text`）和富文本（`post`）照常转成文字。富文本里的代码块单独成块，写成 ```` ```<语言> ```` … ```` ``` ````（语言转小写，没有就留空），和前后文字各隔一行；带删除线的文字写成 `~~…~~`（链接只包文字部分），其他样式（粗体、斜体等）不保留。

**引用回复会附上被引用的原文**：「回复」某条消息时，飞书事件里只有被引用消息的 ID，插件会再取一次那条消息，放在正文前面：

```
> 引用 <发送者>：
> <原文>

<本条正文>
```

- 只取一层；原文超过 2000 字截断；发送者是机器人时写「机器人」，名字也优先用备注名。
- 原文里的图片 / 文件只写成不带序号的 `[图片]` / `[文件: 名字]`，**不下载**，也不带 `image_N` / `file_N` 属性。
- 取不到（被撤回、权限不够、超时 5 秒）时写 `> （引用的消息取不到）`，正文照常投递。取原文需要和下载图片同样的消息读取权限（`im:message:readonly` 等）。

**图片和文件收到即下载**到 inbox（见第 7 步后的"收图片 / 文件要放行 inbox"），只有通过访问控制、真正转给 Claude 的消息才下载（审批 / `auto` 命令、被丢弃的、配对中的都不下）：

- 内容里写成 `[图片 1]`、`[图片 2]`（富文本里的图按出现顺序编号）、`[文件 1: 名字]`，对应的本地路径放在消息属性 `image_1`、`file_1` 里，Claude 用 Read 读这个路径。路径只出现在属性里，不出现在内容里：内容是发送人可控的文字，伪造的路径不算数。
- 上限：图片 10MB、文件 20MB，一条消息最多下 9 个，单个 30 秒超时。没下成的不带属性，占位后面写原因，如 `[图片 2: 下载失败]`、`[文件 1: x.zip，超过 20MB 未下载]`；具体错误（含飞书错误码）在 stderr。
- 文件名：图片 `<YYYYMMDD-HHMMSS>-<message_id 末 8 位>-<序号>.<扩展名>`（扩展名按 Content-Type 或文件头判断，认不出用 `.bin`），文件 `<YYYYMMDD-HHMMSS>-<message_id 末 8 位>-<序号>-<清洗过的原名>`；目录 0700、文件 0600，超过 7 天的在启动和每次下载后清掉。
- 消息按到达顺序交给 Claude：前一条还在下载时，后一条（哪怕是纯文字）会等它。
- **群里发截图要和 @ 在同一条消息里**：应用只收群里 @ 机器人的消息（`im:message.group_at_msg:readonly`），单独发的图片 / 文件飞书根本不推过来。在输入框里粘贴图片再 @ 机器人，会合成一条富文本，这样就行。私聊不受影响。
- **所有会话共用一个 inbox**：不按群 / 私聊分开，文件保留 7 天；`--add-dir` 之后，Claude 能读 inbox 里任何一个文件，包括别的群发来的（HAR、日志里常带 Cookie 等凭据）。只把机器人放进彼此可信的会话。

视频（`[视频]`）、语音（`[语音]`）读不了；表情包、合并转发、卡片等以 `(<类型> message)` 的形式转给 Claude，并带上 `message_type`。需要时 Claude 会请对方转成文字。出站只发纯文本。

**编辑过的消息不会再推过来**：Claude 只看到最初发出的版本。贴错了请重新发一条，别改原消息。富文本里的引用块（`>`）到达时已经没有引用标记，和正文混在一起；列表的 `1.` / `-` 会保留。
