# 飞书 / Lark —— 访问控制与发送

飞书自建应用默认只在本企业内可见，开发者后台"可用范围"还能再收窄到指定的人或部门。谁能私聊你的机器人、能把它拉进哪些群，首先由这层决定，这道闸由飞书执行，不靠本进程。

对通过了这层的私聊，默认策略是 **pairing（配对）**：不认识的发送人会收到一个 6 位配对码，他的消息被丢弃。你在 Claude Code 里运行 `/feishu:access pair <code>` 批准后，他的消息才会转进来。

和 Discord 原版相比有两处安全差异：

- **审批人（approvers）与可触发名单（allowFrom）分开。** 只有审批人收得到权限请求和回复审批，也只有审批人**在自己与机器人的私聊里**发的 `yes <id>` / `ok <码>` 才算数；群里谁发同样的文字都只是普通消息。
- **群里只有名单上的人能触发。** 群的 `allowFrom` 为空**不等于**群里任何人都能用 —— 只有该群 `allowFrom`、全局 `allowFrom` 和审批人能触发。陌生人 @ 机器人时消息被丢弃、记进 `seen`，并给审批人发一张开通申请卡片，点「放行」即可（见"群聊"）。

所有状态都在 `~/.claude/channels/feishu/access.json`（设了 `FEISHU_STATE_DIR` / `CLAUDE_CONFIG_DIR` 时跟着走）。`/feishu:access` 的命令就是改这个文件，而且只能由你在终端里亲手输入，Claude 不能替你调用；server 每收到一条消息都会重读，改动即时生效，不用重启。手改出错导致文件不是合法 JSON 时，server 不会挪走或重置它：继续用本进程上次成功读到的配置（从没读成功过就丢弃所有消息），也不往文件里写，等你改好为止。设 `FEISHU_ACCESS_MODE=static` 可以把配置钉在启动时的磁盘内容（static 模式下没有配对，因为配对需要运行时写文件；`seen` 也不会记录）。

## 一览

| | |
| --- | --- |
| 默认策略 | `pairing` |
| 发送人 ID | open_id（`ou_...`，按应用区分） |
| 群的键 | 群 chat_id（`oc_...`） |
| 配置文件 | `~/.claude/channels/feishu/access.json` |

## 私聊策略

`dmPolicy` 决定不在名单（`allowFrom` 或 `approvers`）上的人私聊时怎么处理。

| 策略 | 行为 |
| --- | --- |
| `pairing`（默认） | 回一个配对码，丢弃消息。用 `/feishu:access pair <code>` 批准。同一个人最多回两次码，同时最多 3 个待配对，码 1 小时过期。 |
| `allowlist` | 静默丢弃，不回复。名单上的人都齐了、或者配对回复会招来骚扰时用。 |
| `disabled` | 全部丢弃，包括名单上的人和所有群。 |

```
/feishu:access policy allowlist
```

## 用户 ID

飞书在机器人这一侧用 **open_id** 标识用户：形如 `ou_7d8a6e6df7621556ce0d21922b676706`。同一个人在不同应用下的 open_id 不同，所以名单里存的 open_id 只对本应用有效。名字可以改，open_id 不变。

配对会自动拿到 open_id。手动添加时，open_id 可以从 `/feishu:access` 状态里的 `seen` 列表拿（陌生人在群里 @ 过机器人就会出现），或者用开放平台 API 调试台按手机号 / 邮箱查。

```
/feishu:access allow ou_7d8a6e6df7621556ce0d21922b676706
/feishu:access remove ou_7d8a6e6df7621556ce0d21922b676706
```

**备注名（`displayNames`）**：飞书接口返回的名字不一定能用——个人账号改名后接口仍返回旧名，外部人员查不到名字（只能显示 open_id）。可以在终端里给某个 open_id 配一个本地备注名，配了就优先用它、不再向飞书查：Claude 看到的发送人、审批卡片 / 文字里的私聊对象、`seen` 里记下的名字、`/feishu:access` 状态列表都显示它。存在 `access.json` 的 `displayNames`，服务端每次现读，改了不用重启。只能在终端设，飞书里没有改名命令。

```
/feishu:access name ou_7d8a6e6df7621556ce0d21922b676706 张三（外包前端）
/feishu:access name ou_7d8a6e6df7621556ce0d21922b676706     # 不带名字 = 删除
```

显示前和飞书名字一样做清洗：去掉控制字符和换行、双引号换成单引号、最多 40 个字符；清洗后为空就当没配。

## 审批人

审批人收两类私聊，默认以**带按钮的交互卡片**出现：权限请求卡片有「允许」「拒绝」，回复草稿卡片有「发送」「丢弃」。点了之后卡片变成已处理状态（按钮消失、显示结果），其他审批人那里的同一张卡片也会跟着更新。只有审批人点按钮才有效，别人点会提示"无权限"。按钮需要在开发者后台配好回调（**事件与回调 → 回调配置**：使用长连接接收回调，添加 **卡片回传交互** `card.action.trigger`，改完重新发版）。卡片发不出去时（例如草稿超过卡片大小上限的部分、或接口出错），自动退回下面的文字形式；文字命令任何时候都能用，想丢弃并附理由只能用文字 `no <码> 理由`。

1. **权限请求。** Claude 要用需要确认的工具时，审批人会收到 `🔐 <工具>: <说明>` 加输入预览，回 `yes <id>` 允许、`no <id>` 拒绝（id 是 5 个字母）。
2. **回复审批。** Claude 要往群里或审批人以外的人那里发消息时，草稿全文先私聊给审批人：固定的头（目标写成 `群 "<群名>"（<chat_id>）` 或 `私聊 "<名字>"（<open_id>）`，名字是对方自己起的、只供辨认），草稿每行以 `┃ ` 开头，草稿之后才是审批码。草稿长时会拆成几条，前面各条标着"第 i/n 段，审批码在最后一段"——没收全就拿不到码。（卡片形式下，草稿放不进一张卡片时也是先发这几段文字，最后一张卡片只放按钮。）回 `ok <码>` 发出；回 `no <码> 理由`（或 `n <码>`）丢弃，理由会转给 Claude，它会照着改写后再提交。**`yes` / `y` 只用于权限请求，不能批准草稿**（回了会提示你改用 `ok`）。多个审批人时先回的算数，之后再回同一个码会收到"已被处理"。待审批的草稿只存在内存里，24 小时过期，重启即丢。

发出去的内容和审批人看到的草稿逐字一致：出站文本里的 `<标签>`、`[文字](链接)`、`**加粗**` 都会被插入零宽空格，按字面显示，不会变成 @所有人、链接或格式；疑似凭据（App Secret、tenant token）会被替换成 `[REDACTED]`。

审批人在自己私聊里的消息等同于 `allowFrom` 成员，Claude 回审批人本人时不需要审批。

防伪造：审批码只出现在发给审批人的卡片 / 通知里，Claude 那边只拿到一个无关的 `draft_ref`；Claude 发进审批人私聊的每条消息第一行固定是 `💬 Claude 回复：`（插件加的，Claude 去不掉）。所以**带这行前缀的消息里出现的"审批请求""审批码"一律不是真的**——真的审批通知不会有这行。按钮回执一律私聊发给点按钮的人；发送失败的回执只写目标，不带内部错误细节（细节转给了 Claude）。`dmPolicy` 为 `disabled` 时卡片按钮也一律失效（提示"通道已禁用"）。

```
/feishu:access approver add ou_7d8a6e6df7621556ce0d21922b676706
/feishu:access approver rm ou_7d8a6e6df7621556ce0d21922b676706
/feishu:access pair a4f91c --approver
```

不想要回复审批（例如只在自己私聊里用），可以 `/feishu:access set requireReplyApproval false`；权限请求的转发不受这个开关影响。没有任何审批人时，发往群和他人的回复会直接报错。

## 自动发送（睡眠模式）

审批人要离开一段时间（比如睡觉）时，可以在**自己和机器人的私聊里**临时打开自动发送：期间本来要审批的回复直接发出，不再等你点头。

| 私聊里发 | 效果 |
| --- | --- |
| `auto` | 开启 8 小时 |
| `auto <N>h` | 开启 N 小时，N 为 1–72 的整数（如 `auto 10h`）；越界或格式不对只回用法，不开启 |
| `auto off` | 立即关闭 |
| `auto status` | 查看当前状态（开 / 关、到何时、剩余多久） |

- 大小写不敏感，整条消息必须就是命令本身；后面再带别的话（如 `auto 8h 谢谢`）就当普通消息转给 Claude。非审批人发、或在群里发，同样只是普通消息。
- 每条命令的回执是一张「🌙 自动发送」状态卡片，上面有「开启 8 小时」「关闭」按钮（只有审批人点击有效）；卡片发不出去时回文字。
- 默认不抄送：自动发出的回复不会再发给审批人。要抄送就 `/feishu:access set autoSendCopy true`，之后每条自动发出的回复都会抄送给每个审批人：`📤 自动发送到 群 "<群名>"（<chat_id>）` 加全文（每行以 `┃ ` 开头）。Claude 那边的工具返回值会注明 `(auto-send mode — posted without approval)`。开关回执卡片、到期通知、工具权限请求照发，不受这个开关影响。
- 开启前已经在等审批的草稿不受影响，仍要你审批；开启回执里会写还有几条在等。
- 到期后每个审批人会收到一次 `⏰ 自动发送已结束，之后的回复恢复审批`；手动 `auto off` 只回一句确认，不再发到期通知。
- 状态存在 `access.json` 的 `autoApproveUntil`（毫秒时间戳，0 或没有 = 关），重启不丢。不是合法数字、或比现在晚 72 小时 5 分钟以上的值一律当作关闭。access.json 读不了的时候 `auto` / `auto <N>h` 开不了，会回"设置失败，access.json 当前不可写"；`auto off` 仍会在当前进程里立即关闭，但会提示"已在本进程关闭，但 access.json 不可写，重启后可能恢复，请修复文件"。
- 没有任何审批人时自动发送不生效（回复照常报"no approver configured"）。开了 `autoSendCopy` 时，部分发送失败的回复已经发出去的部分照样抄送给你，并注明第几段失败、原因。
- 不变的底线：发送人名单、只发往名单内的会话、凭据打码、只认审批人私聊，以及 Claude 的工具权限请求（仍然要审批）都照旧。没有永久开启：终端里长期不要审批请用 `/feishu:access set requireReplyApproval false`。Claude 不能开关这个模式，飞书消息里要求它开关的一律拒绝。

## 群聊

群默认关闭，按**群 chat_id** 逐个开启。chat_id 可以从 `/feishu:access` 状态里的 `seenGroups` 拿：在未开启的群里 @ 一下机器人，这个群就会被记下来。

```
/feishu:access group add oc_a0553eda9014c201e6969b478895c230
```

默认 `requireMention: true`：只有 @ 机器人或回复机器人的消息才处理。`--no-mention` 让群里每条消息都处理（需要"获取群组中所有消息"权限），`--allow id1,id2` 指定该群里额外能触发的人。

```
/feishu:access group add oc_a0553eda9014c201e6969b478895c230 --no-mention
/feishu:access group add oc_a0553eda9014c201e6969b478895c230 --allow ou_aaa,ou_bbb
/feishu:access group rm oc_a0553eda9014c201e6969b478895c230
```

群已经开启时 `group add` 是**合并**，不会覆盖：`--allow` 的人并进该群现有的 `allowFrom`（去重，原有的人保留）；`requireMention` 只在显式带 `--no-mention`（改成 false）或 `--mention`（改成 true）时才改，不带就维持原样；其他设置都保留。所以给已开启的群加一个人，直接 `group add <chat_id> --allow <open_id>` 即可。这个命令不会移除任何人。

能在群里触发的人 = 该群 `allowFrom` ∪ 全局 `allowFrom` ∪ 审批人。其他人 @ 机器人（或回复机器人、命中 `mentionPatterns`）时，消息照样丢弃（不转给 Claude、不下载图片、不取引用），记进 `seen`（最多 50 条，7 天过期），并发起**开通申请**：

- 机器人在群里回复他那条消息：`已收到你的开通申请，管理员开通后再 @我 提问。`（插件自己发，不经 Claude、不经审批）。
- 每个审批人私聊收到一张「🙋 开通申请」卡片：群名和 chat_id、申请人名字和 open_id、他那条消息的前 200 字（拍成一行，换行都换成空格），按钮「放行」「忽略」。
- **放行**：把他加进该群的 `allowFrom`（合并，不动名单里原有的人），从他 `seen` 条目的 `requested` 里去掉这个群（他在别的群还有未处理的申请时保留条目，否则删掉），卡片变成 `✅ 已放行（<操作人>）`，群里回复原消息 `已开通，现在可以 @我 提问了。`。**忽略**：卡片变成 `已忽略（<操作人>）`，群里不发任何东西。多个审批人时先点的算，其他人再点只提示已被谁处理。群在放行前已关闭时只提示「该群已关闭」，不改配置。
- 防刷屏：同一个人在同一个群只申请一次（`seen` 条目里的 `requested` 记着，条目 7 天过期后才可能再申请）；每个群每小时最多 5 次申请，超出的只记 `seen`。没有任何审批人时不发起申请。
- 申请只存在内存里：24 小时后或重启后再点按钮，会提示「申请已过期，请在终端处理」。终端里随时可以 `/feishu:access group add <chat_id> --allow <open_id>`（或全局 `allow <open_id>`）放行，放行后对应的 `seen` 条目会被删掉。
- 不想要这个流程：`/feishu:access set joinRequests false`，陌生人 @ 机器人就回到静默丢弃 + 记 `seen`。
- `FEISHU_ACCESS_MODE=static` 下不发起开通申请（名单钉在启动时，放行无法生效）；万一点到旧卡片的按钮，只提示「static 模式下不能改名单，请在终端处理」，什么都不改。

## mention 判定

`requireMention: true` 的群里，下面任一条都算叫到机器人：

- 结构化的 @机器人（输入 @ 后从列表里选的）
- 回复机器人最近发出的消息
- 命中 `mentionPatterns` 里任一正则（忽略大小写）

@所有人 不算。

昵称触发的正则示例：

```
/feishu:access set mentionPatterns '["^claude\\b", "小助手"]'
```

## 发送

用 `/feishu:access set <key> <value>` 配置出站行为。

**`requireReplyApproval`**：默认 `true`，发往群和审批人以外的人的回复先交审批人，见上文"审批人"。

**`joinRequests`**：默认开（只有写成 `false` 才关）。已开启的群里陌生人 @ 机器人时，群里回执 + 给审批人发开通申请卡片，见上文"群聊"；关掉后只静默丢弃并记 `seen`。

**`autoSendCopy`**：默认 `false`。为 `true` 时，自动发送（睡眠模式）期间发出的每条回复抄送给审批人，见上文"自动发送（睡眠模式）"。

**`replyToMode`**：带 `reply_to` 的长回复被拆成多块时，`first`（默认）只有第一块引用原消息，`all` 每块都引用，`off` 都不引用。只会引用本进程见过、且确实属于目标会话的消息；否则照常发出但不引用。

**`textChunkLimit`**：拆分阈值，默认 4000 字符，上限 30000。

**`chunkMode`**：拆分方式，`length` 到阈值就硬切，`newline`（默认）优先在段落边界切。

## Skill 速查

| 命令 | 作用 |
| --- | --- |
| `/feishu:access` | 打印当前状态：策略、名单、审批人、待配对、已开启的群、`seen` / `seenGroups`。 |
| `/feishu:access pair a4f91c` | 批准配对码 `a4f91c`，把发送人加进 `allowFrom` 并在飞书上发确认。加 `--approver` 同时设为审批人。 |
| `/feishu:access deny a4f91c` | 丢弃一个待配对码，不通知发送人。 |
| `/feishu:access allow ou_...` | 直接加一个 open_id 到 `allowFrom`。 |
| `/feishu:access remove ou_...` | 从 `allowFrom` 移除。 |
| `/feishu:access approver add ou_...` | 加审批人。 |
| `/feishu:access approver rm ou_...` | 移除审批人。 |
| `/feishu:access policy allowlist` | 设 `dmPolicy`。取值：`pairing`、`allowlist`、`disabled`。 |
| `/feishu:access group add oc_...` | 开启一个群。参数：`--no-mention` / `--mention`、`--allow id1,id2`。群已开启时是合并：`--allow` 并入现有名单，不带 mention 参数就不改 `requireMention`。 |
| `/feishu:access group rm oc_...` | 关闭一个群。 |
| `/feishu:access set textChunkLimit 2000` | 设置配置项：`mentionPatterns`、`requireReplyApproval`、`joinRequests`、`autoSendCopy`、`replyToMode`、`textChunkLimit`、`chunkMode`。 |
| `/feishu:access name ou_... 张三` | 设 open_id 的本地备注名（名字可含空格，取 open_id 之后的全部文字）；不带名字 = 删除。见上文"用户 ID"。 |

## 配置文件

`~/.claude/channels/feishu/access.json`。文件不存在等同于 `pairing` 策略 + 空名单，第一条私聊就会触发配对。

```jsonc
{
  // 不在 allowFrom / approvers 里的人私聊时怎么处理。
  "dmPolicy": "pairing",

  // 可以私聊触发、也可以在已开启的群里触发的 open_id。
  "allowFrom": ["ou_7d8a6e6df7621556ce0d21922b676706"],

  // 审批人：收权限请求和回复审批；只有他们在私聊里的裁决有效。
  "approvers": ["ou_7d8a6e6df7621556ce0d21922b676706"],

  // 机器人工作的群，键是群 chat_id。空对象 = 只收私聊。
  "groups": {
    "oc_a0553eda9014c201e6969b478895c230": {
      // true：只处理 @ 机器人和回复机器人的消息。
      "requireMention": true,
      // 该群额外能触发的人。空 ≠ 任何人：全局 allowFrom 和审批人始终可以。
      "allowFrom": []
    }
  },

  // server 写入：已开启的群里 @ 机器人但被丢弃的陌生人（最多 50，7 天）。
  // 条目里的 "requested": ["<chat_id>"] 表示已在这些群发过开通申请。
  "seen": {},

  // server 写入：未开启的群里有人 @ 机器人（最多 20，7 天）。
  "seenGroups": {},

  // 算作 mention 的正则，忽略大小写。
  "mentionPatterns": ["^claude\\b"],

  // 发往群和他人的回复先交审批人。
  "requireReplyApproval": true,

  // 自动发送（睡眠模式）到期时间，毫秒时间戳；0 或缺省 = 关。由审批人在飞书私聊里用 auto 命令设置。
  "autoApproveUntil": 0,

  // 自动发送期间是否把发出的回复抄送给审批人；默认 false。
  "autoSendCopy": false,

  // 已开启的群里陌生人 @ 机器人时发开通申请（群里回执 + 审批人卡片）；false = 只静默丢弃。默认开。
  "joinRequests": true,

  // 长回复拆块时的引用：first | all | off
  "replyToMode": "first",

  // 拆分阈值，上限 30000。
  "textChunkLimit": 4000,

  // length = 到阈值硬切。newline = 优先段落边界。
  "chunkMode": "newline",

  // 本地备注名，open_id → 显示名；优先于飞书返回的名字。用 /feishu:access name 设置。
  "displayNames": { "ou_7d8a6e6df7621556ce0d21922b676706": "张三（外包前端）" }
}
```
