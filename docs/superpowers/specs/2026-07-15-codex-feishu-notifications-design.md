# Codex 全局飞书通知设计

日期：2026-07-15  
状态：已废弃，由 `2026-07-16-codex-structured-feishu-notifications-design.md` 取代

> 本文把 Codex JSONL 中的 `task_complete` 当成业务任务完成。生产验证证明该假设错误：`task_complete` 只表示当前回合结束。后续实现以 2026-07-16 的结构化状态协议设计为准。

## 1. 目标

只要这台 Mac 上运行或同步的 Codex 任务进入以下状态，`codexbot` 就向 Joulian 的飞书私聊发送提醒：

- 需要审批或等待回答；
- 任务完成。

提醒必须在一眼能分辨状态的同时，明确显示项目名称和任务名称。现有 ChatGPT Work、Codex Desktop 和 Codex CLI 原生通知保持不变。

正常网络下，从 Codex 产生事件到飞书消息送达的目标时间不超过 3 秒。

## 2. 范围

首版覆盖：

- ChatGPT Work / Codex Desktop 在本机执行或同步的任务；
- Codex CLI 和 IDE 产生的本机会话；
- 通过 `cli2im` 运行的 `codexbot` 任务。

首版不覆盖：

- 只在网页云端执行、没有同步到本机的 Codex 任务；
- 飞书内直接批准命令或回答 Codex 问题；
- 开始运行、继续运行、工具调用进度等低价值状态；
- 任务内容、代码、Diff 或日志的跨设备转发。

## 3. 已确认的现状

- `~/.codex/config.toml` 已启用 `agent-turn-complete` 和 `approval-requested` 原生通知；这些设置保留。
- 当前 `codexbot` 由 `/Users/xiaoyangyu/projects/cli2im` 和 `com.cli2im.bridge` 提供服务。
- Codex 0.144.3 的本地协议包含审批请求、`item/tool/requestUserInput` 和 `turn/completed`；本机会话 JSONL 中有 `task_started`、`request_user_input` 和 `task_complete` 可供监听。
- `cli2im` 已有飞书适配器、交互卡片、本地持久化数据库和常驻 LaunchAgent，不需要新增第二套飞书连接或常驻服务。

## 4. 总体架构

通知功能直接集成进现有 `cli2im` 进程。

```text
Codex PermissionRequest Hook ─┐
                              ├─> 事件标准化 ─> 去重/隐私过滤 ─> 飞书 codexbot 卡片
Codex 会话 JSONL 监听器 ──────┘

Codex 原生本机通知 ───────────────────────────────> 保持原样
```

### 4.1 审批 Hook

用户级 Codex `PermissionRequest` Hook 接收审批事件，只提取会话 ID、轮次 ID、Codex 提供的请求 ID、工作目录、事件类别和时间。Codex 没有提供请求 ID 时，Hook 用会话 ID、轮次 ID、工具名和事件时间窗口生成稳定摘要，不读取或转发命令正文。Hook 通过 `~/.cli2im/codex-notify.sock` 把事件交给 `cli2im`。

Socket 位于权限为 `0700` 的 `~/.cli2im` 目录，Socket 自身只允许当前用户访问。Hook 不读取或复制 `cli2im` 的 HTTP Token，也不把凭据放入命令行和日志。

Hook 发送失败时直接退出，不阻塞 Codex 的审批界面。原生通知继续工作。

### 4.2 Codex 会话监听器

`CodexEventMonitor` 在 `cli2im` 内监听 `~/.codex/sessions` 新增和增长的 `rollout-*.jsonl`：

- `response_item.function_call.name == request_user_input`：生成“等待回答”事件；
- `event_msg.type == task_complete`：生成“任务完成”事件；
- `event_msg.type == turn_aborted`：只更新内部状态，不发送完成通知。

监听器只读取识别事件所需的字段，不加载完整对话到内存。文件轮转、Codex 重启和 `cli2im` 重启后，从持久化游标继续读取。

首次启用时以当前文件末尾为基线，禁止补发历史任务形成消息风暴。

### 4.3 事件标准化

内部只保留两种通知状态：

```ts
type CodexNotificationKind = 'needs_attention' | 'completed';
type AttentionReason = 'approval' | 'question';
```

标准事件字段：

- `eventKey`：去重键；
- `kind`：待处理或完成；
- `reason`：审批或问题，仅待处理事件使用；
- `sessionId`、`turnId`、`requestId`：只在本地用于关联和去重；
- `projectName`、`taskName`：飞书卡片强制字段；
- `surface`：根据会话来源识别为 ChatGPT Work、Codex Desktop、CLI、IDE 或 codexbot；无法确认时显示 `Codex`，不猜具体入口；
- `occurredAt`、`durationMs`；
- `shortTaskId`：无法从标题定位时使用的短 ID。

## 5. 项目名和任务名

### 5.1 项目名称

按以下优先级取值：

1. 工作目录对应的 Git 仓库根目录名；
2. 工作目录最后一级目录名；
3. `未识别项目`。

只发送名称，不发送完整本机路径。工作目录到项目名的解析结果按会话缓存，避免每个事件重复执行 Git 查询。

### 5.2 任务名称

按以下优先级取值：

1. `~/.codex/session_index.jsonl` 中当前会话的 `thread_name`；
2. 当前轮次用户请求的第一条有效文本；
3. 纯附件任务使用 `处理文件：<文件名>` 或 `分析图片：<文件名>`；
4. `未命名任务 · <短任务 ID>`。

发送前统一处理：

- 忽略系统、开发者、`AGENTS.md`、`environment_context` 和工具回传内容，只从真实用户请求取标题；
- 去除代码块和 Markdown 链接目标；
- 去除 URL 查询参数；
- 将用户主目录和完整绝对路径改为文件名或目录名；
- 屏蔽密钥、Token、密码、Cookie、私钥头等常见敏感格式；
- 合并空白并限制在约 40 个中文字符或 80 个拉丁字符；
- 不调用额外模型生成标题，避免延迟和数据外发。

## 6. 飞书卡片

### 6.1 待处理

- 标题：`🟠 待你处理`
- 飞书标题栏颜色：橙色
- 字段：项目、任务、原因、位置、时间

示例：

```text
🟠【待你处理】

项目：cli2im
任务：为所有 Codex 任务增加飞书提醒
原因：需要批准命令执行
位置：ChatGPT Work · Joulian 的 Mac
时间：14:32
```

### 6.2 任务完成

- 标题：`🟢 任务完成`
- 飞书标题栏颜色：绿色
- 字段：项目、任务、位置、完成时间、耗时

示例：

```text
🟢【任务完成】

项目：cli2im
任务：为所有 Codex 任务增加飞书提醒
位置：ChatGPT Work · Joulian 的 Mac
完成：14:35
耗时：3 分 18 秒
```

卡片不提供审批按钮，也不包含任务结果全文。

`CardPayload` 增加受限的标题栏颜色字段，只允许现有默认值、`orange` 和 `green`，避免调用方注入任意卡片结构。

## 7. 收件人绑定

Joulian 在目标 `codexbot` 私聊中发送一次 `/notify-me`：

- 只允许 `codexbot` 配置中的白名单用户执行；
- 只允许一对一私聊，群聊请求直接拒绝；
- 保存当前飞书私聊的 `chatId` 和发送者 `userId`；
- 日志不输出原始 `chatId`、`userId` 或任务标题；
- 重复执行 `/notify-me` 会更新绑定，不产生多条绑定。

没有有效绑定时不向任何飞书会话发送通知，避免猜测收件人。

## 8. 去重和持久化

在现有 `SessionStore` 数据库中新增三类数据：

- 通知绑定：目标 bot、平台、私聊和用户；
- 会话游标：文件标识、读取偏移和更新时间；
- 投递记录：事件去重键、状态、尝试次数和时间。

去重键规则：

- 审批：`sessionId + turnId + requestId + approval`；
- 等待回答：`sessionId + turnId + requestId + question`；
- 完成：`sessionId + turnId + completed`。

同一个等待事件只提醒一次；同一轮任务只发送一次完成提醒。待处理事件恢复运行后，不额外发送“已恢复”。

待重试的卡片只保存经过脱敏和长度限制后的允许字段。投递成功后只保留去重键和时间，不长期保留卡片正文。

## 9. 失败处理

- 飞书发送失败按 `1 秒 → 5 秒 → 20 秒` 重试；
- 超过 30 秒才送达的卡片标记为“延迟送达”；
- `cli2im` 重启后继续未完成的重试；
- Socket 不可用、JSONL 单行损坏或未知事件类型只记安全摘要，不中断 `cli2im`；
- 单个 Hook 事件最大 8 KB，超过限制直接拒绝；
- 飞书失败不影响 Codex 任务，也不改变现有原生通知。

通知模块的日志只记录事件类型、短事件 ID、投递状态和错误类别。禁止记录原始 Hook 输入、卡片正文、完整路径、飞书 ID 和任何环境变量。

## 10. 配置

在 `cli2im` 配置中增加一个窄范围开关：

```yaml
notifications:
  codex:
    enabled: true
    botName: codexbot
```

会话目录、索引文件和 Socket 使用当前用户目录下的固定默认位置，不增加没有实际需求的可配置项。

## 11. 测试

开发采用测试先行，至少覆盖：

- 识别审批、`request_user_input`、`task_complete` 和 `turn_aborted`；
- 项目名解析及无 Git 仓库时的回退；
- 任务标题优先级、截断和敏感信息屏蔽；
- 审批、问题和完成事件的去重键；
- 文件增长、轮转、重启游标和首次启动基线；
- `/notify-me` 的白名单、私聊限制和重复绑定；
- 橙色、绿色卡片结构；
- 飞书失败重试、延迟标记和重启续传；
- Socket 权限、载荷大小和异常 JSON；
- 通知日志不包含敏感字段。

合并和上线前运行：

```bash
npm test
npm run typecheck
npm run build
```

## 12. 上线和回滚

上线前先按本机安全规则核对网络资产台账，确认设备所有权和环境。随后：

1. 备份 `cli2im` 数据库、生产构建和将要修改的 Codex Hook 配置；
2. 部署新构建并重启现有 `com.cli2im.bridge`；
3. 确认原生 Codex 通知配置没有被关闭；
4. 在 `codexbot` 私聊执行 `/notify-me`；
5. 实测一张橙色待处理卡片和一张绿色完成卡片；
6. 核对项目名、任务名、去重和送达时间。

回滚时关闭 `notifications.codex.enabled` 并恢复上一版生产构建。新建的 Hook 保留为无害空操作，除非 Joulian 再确认删除；数据库和配置备份也不自动删除。

## 13. 验收标准

- 审批、等待回答、完成事件都能触发正确类型的飞书提醒；
- 两种卡片颜色、图标和标题明显不同；
- 每张卡片都显示项目名称和任务名称；
- 不发送完整提示词、命令、代码、日志、完整路径或凭据；
- 相同事件不重复发送，重启后仍不重复；
- 正常网络下送达时间不超过 3 秒；
- 原生 ChatGPT Work、Codex Desktop 和 Codex CLI 通知保持开启；
- `npm test`、`npm run typecheck`、`npm run build` 全部通过；
- 生产服务重启后保持运行，飞书实测两类卡片均送达。
