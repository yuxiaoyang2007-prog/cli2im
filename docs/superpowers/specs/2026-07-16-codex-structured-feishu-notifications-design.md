# Codex 结构化飞书通知设计

日期：2026-07-16  
状态：已完成对话确认，待书面复核

本文取代 `2026-07-15-codex-feishu-notifications-design.md`。旧方案把 JSONL 中的 `task_complete` 当成业务任务完成，已经被生产数据证明不成立。

## 1. 目标

为这台 Mac 上的 Codex 任务提供两种飞书提醒：

- `🟠 待你处理`：任务需要审批、确认、选择或补充信息；
- `🟢 任务完成`：Codex 明确上报交付和验证已经结束。

提醒必须包含项目名和任务名。正常情况下，从结构化状态产生到飞书送达不超过 3 秒。现有 Codex、ChatGPT Work、CLI 和 IDE 原生通知保持开启。

准确性优先。没有明确完成信号就不发绿色提醒，宁可漏报，不用文本或回合结束事件猜测完成。

## 2. 范围

首版覆盖：

- Codex Desktop 和 ChatGPT Work 在本机执行或同步的任务；
- Codex CLI 与 IDE 使用本机 Codex 配置运行的任务；
- `cli2im` 中现有 `codexbot` 飞书私聊；
- 本机服务短暂退出、重启和飞书临时失败后的补发。

首版不覆盖：

- 没有同步到本机、也不执行本机 Hooks 的纯云端任务；
- 在飞书里直接批准 Codex 命令或回答 Codex 问题；
- 开始运行、工具进度、恢复运行等过程通知；
- 任务结果全文、代码、Diff、命令或日志的跨设备转发。

## 3. 设计原则

1. `Stop`、JSONL `task_complete` 和助手自然语言都不能直接触发绿色提醒。
2. 绿色提醒只能来自成功调用的结构化 `mark_completed` 工具。
3. 橙色提醒来自 `PermissionRequest` 或成功调用的 `mark_waiting` 工具。
4. JSONL 只做元数据恢复和故障对账，不判断业务状态。
5. 飞书故障不能阻塞 Codex；Codex Hook 故障也不能改变任务执行结果。
6. 原始提示词、完整路径和工具内容不落入通知数据库或补发队列。

## 4. 总体架构

功能由个人插件 `codex-task-notifier` 和现有 `cli2im` 共同完成。

```text
Codex UserPromptSubmit Hook ────────> 任务登记 ───────────────┐
Codex PermissionRequest Hook ──────> 审批事件 ───────────────┤
Codex MCP mark_waiting ─PostToolUse> 等待事件 ───────────────┤
Codex MCP mark_completed ─PostToolUse> 完成事件 ─────────────┤
Codex Stop Hook ───────────────────> 状态完整性检查           │
                                                             ▼
                                              Unix Socket / 本地 outbox
                                                             ▼
                                               cli2im 任务状态机与去重
                                                             ▼
                                                飞书 codexbot 私聊卡片

Codex 原生通知 ───────────────────────────────────────> 保持原样
```

个人插件包含：

- `.codex-plugin/plugin.json`；
- 一个本地 MCP 服务，暴露状态工具；
- `hooks/hooks.json`；
- Hook 客户端和共享的脱敏、事件签名代码；
- `SessionStart`、`SubagentStart` 注入的窄范围行为约束。

插件安装到个人 Codex 环境，覆盖使用同一 `CODEX_HOME` 的 Desktop、CLI 和 IDE。非托管 Hook 首次启用时按 Codex 官方流程完成一次信任确认。

## 5. MCP 状态工具

插件只提供两个状态工具：

```ts
mark_waiting({
  reason: 'question' | 'confirmation'
})

mark_completed({})
```

工具不接收项目名、任务名、提示词或结果摘要。项目和任务身份只能来自 Hook 建立的本地任务记录，防止模型填错名称或把一个任务的状态写到另一个任务。

工具语义：

- `mark_waiting`：当前任务已经停下，必须等用户输入才能继续；
- `mark_completed`：用户要求的交付物已经完成，必要验证已经通过，没有遗留审批、选择或确认；
- 工具返回成功后，`PostToolUse` Hook 才提交状态事件；工具调用失败不改变任务状态。

插件在 `SessionStart` 和 `UserPromptSubmit` 的附加上下文中明确要求主代理使用这两个工具。`SubagentStart` 明确禁止子代理上报主任务完成。

## 6. 任务身份与标题

### 6.1 新任务

`UserPromptSubmit` Hook 使用官方输入字段 `session_id`、`turn_id`、`cwd` 和 `prompt` 登记任务。

默认每条真实用户新请求创建一个任务。任务 ID 由 `session_id + 首个 turn_id + 提交序号` 生成稳定摘要，不向飞书暴露完整 ID。

Stop Hook 为补报状态而自动生成的协议续跑提示不算真实用户请求。Hook 在发起续跑前写入 `protocol_continuation_pending` 标记；下一次 `UserPromptSubmit` 命中该标记时沿用原任务和任务名，只更新当前 `turn_id`，随后清除标记。

### 6.2 等待后的继续

如果当前任务处于 `WAITING_APPROVAL` 或 `WAITING_QUESTION`，下一条用户输入恢复同一任务：

- 任务 ID 不变；
- 任务名不变；
- 更新当前 `turn_id`；
- 状态回到 `RUNNING`。

如果上一任务是 `COMPLETED` 或 `ENDED_UNREPORTED`，下一条用户输入创建新任务。

### 6.3 项目名

按以下顺序确定：

1. `cwd` 对应的 Git 仓库根目录名；
2. `cwd` 最后一级目录名；
3. 无法得到可靠名称时不发送结构化状态卡片，等待元数据恢复。

完整路径不持久化到通知记录或 outbox。

### 6.4 任务名

任务名来自 `UserPromptSubmit.prompt`，在 Hook 进程内完成处理：

- 去除代码块、Markdown 链接目标和 URL 查询参数；
- 将绝对路径缩成文件名或目录名；
- 屏蔽 Token、密码、Cookie、私钥和其他常见凭据；
- 合并空白并限制长度；
- 只把处理后的标题交给 `cli2im`。

无法得到安全、可识别的任务名时，不发送绿色提醒。JSONL 和 `session_index.jsonl` 只可用于恢复显示元数据，不能补造完成状态。

## 7. 状态机

内部状态如下：

```ts
type TaskState =
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_QUESTION'
  | 'COMPLETED'
  | 'ENDED_UNREPORTED'
  | 'CANCELLED';
```

主要流转：

```text
UserPromptSubmit
    └─> RUNNING
          ├─ PermissionRequest ─> WAITING_APPROVAL ─> 橙色提醒
          ├─ mark_waiting ─────> WAITING_QUESTION ─> 橙色提醒
          ├─ mark_completed ───> COMPLETED ────────> 绿色提醒
          ├─ turn_aborted ─────> CANCELLED ────────> 不提醒
          └─ Stop 无状态 ──────> 强制继续一次
                                  └─ 仍无状态 ─────> ENDED_UNREPORTED，不提醒
```

约束：

- `COMPLETED` 是终态；完成后的等待、重复完成和旧事件全部拒绝；
- 同一任务可以多次等待，但每次必须有新的 `turn_id` 或请求/工具调用 ID；
- `SubagentStop` 不产生主任务状态；
- 子代理的自然语言和回合完成事件不参与判断；
- 普通 `Stop`、JSONL `task_complete`、`last_assistant_message` 都不能创建绿色事件。

## 8. Stop 完整性检查

`Stop` Hook 只检查当前回合是否已经产生结构化状态。

第一次停止且当前回合没有成功调用 `mark_waiting` 或 `mark_completed` 时：

```json
{
  "decision": "block",
  "reason": "Before stopping, report the task state with mark_waiting or mark_completed."
}
```

Codex 会自动继续一次。继续后的任务必须调用状态工具，再正常结束。

返回继续决定前，Stop Hook 先写入不含任务正文的 `protocol_continuation_pending` 标记。自动生成的续跑提示使用保留前缀，`UserPromptSubmit` 必须同时校验本地标记和前缀；只有两者都匹配时才按协议续跑处理。用户手工输入相同文字不能复用旧任务状态。

如果 `stop_hook_active == true` 且仍未上报状态，Hook 不再阻止停止：

- 任务记为 `ENDED_UNREPORTED`；
- 不发绿色提醒；
- 记录不含任务正文的协议违规摘要；
- 不进入第二次继续，避免死循环。

`PermissionRequest` 只负责发送审批提醒，不能代替回合结束前的状态上报。审批通过后任务可能继续运行，因此主代理最终仍须调用 `mark_waiting` 或 `mark_completed`。如果审批被拒绝后代理无法给出明确状态，按 `ENDED_UNREPORTED` 处理。

## 9. Hook 事件

### 9.1 UserPromptSubmit

职责：

- 创建或恢复任务；
- 生成项目名和安全任务标题；
- 把任务协议作为附加上下文交给主代理；
- 不阻止正常用户输入。

### 9.2 PermissionRequest

职责：

- 提取 `session_id`、`turn_id`、请求 ID、工具名和时间；
- 生成 `WAITING_APPROVAL`；
- 不读取或发送命令正文、参数和工具输入；
- Hook 失败时不阻塞 Codex 原生审批界面。

### 9.3 PostToolUse

只匹配插件 MCP 工具的完整工具名：

- `mcp__codex_task_notifier__mark_waiting`；
- `mcp__codex_task_notifier__mark_completed`。

职责：

- 只在工具成功返回后提交事件；
- 使用 Hook 提供的真实 `session_id`、`turn_id` 和工具调用标识；
- 忽略工具参数中不属于允许字段的内容；
- 失败时由 `Stop` 完整性检查兜底。

### 9.4 SubagentStart 与 SubagentStop

`SubagentStart` 给子代理加入明确约束：不得调用主任务状态工具。`SubagentStop` 只更新诊断状态，不发送飞书提醒。

### 9.5 Stop

按第 8 节执行一次性完整性检查。Stop 是回合级事件，不表示业务任务完成。

## 10. 本地传输与 outbox

正常链路使用现有 `~/.cli2im/codex-notify.sock`：

- `~/.cli2im` 权限为 `0700`；
- Socket 权限为 `0600`；
- 单个载荷上限 8 KB；
- 只接受版本化、白名单化的事件结构；
- Hook 不等待飞书网络请求。

Socket 不可用时，Hook 把已经脱敏的事件原子写入本地 outbox：

- 每个事件一个文件；
- 文件名使用事件摘要，不含任务标题；
- 文件权限 `0600`；
- 不保存原始 prompt、cwd、命令、代码或日志；
- `cli2im` 每 500ms 扫描；
- 飞书确认接收且投递状态落库后，才清理对应文件；
- 同一事件被 Socket 和 outbox 同时提交时，由事件键去重。

### 10.1 回合状态标记

`Stop` Hook 不直接查询 `cli2im` 数据库，也不要求守护进程必须在线。`PostToolUse` Hook 在提交状态事件前，先为当前 `session_id + turn_id` 原子写入一个本地状态标记：

- 标记只包含事件摘要、`waiting` 或 `completed` 状态和时间；
- 不包含项目名、任务名、prompt、cwd 或工具输出；
- 文件位于权限为 `0700` 的专用目录，文件权限为 `0600`；
- `Stop` 只读取当前回合的标记，不能复用旧轮次状态；
- `protocol_continuation_pending` 只允许消费一次，并绑定当前会话和任务；
- 当前回合停止且事件成功落库后删除标记；异常遗留标记最多保留 7 天。

这样即使 `cli2im` 正在重启，`Stop` 也能准确判断当前回合是否已经上报结构化状态。`PermissionRequest` 不写完成性标记，不能绕过 Stop 检查。

## 11. cli2im 任务台账

在现有 SQL.js 数据库中增加结构化任务和事件记录。

任务记录保存：

- `task_id`；
- `session_id`；
- 当前和首个 `turn_id`；
- 项目名、任务名；
- 当前状态；
- 创建、更新时间；
- 最近一次等待或完成事件摘要。

事件记录保存：

- 稳定事件键；
- 任务 ID 和状态类型；
- 请求 ID 或工具调用 ID；
- 发生、首次尝试、送达时间；
- 重试和终态。

完成投递后清空卡片正文和短期传输字段，只保留去重、状态和时间所需数据。

事件键由以下字段生成：

```text
sessionId + taskId + turnId + state + requestId/toolUseId
```

## 12. 飞书卡片

### 12.1 待处理

```text
🟠 待你处理

项目：power-trader-edu
任务：生成宣传讲解 HTML PPT
原因：需要确认方案
位置：Codex Desktop
时间：14:32
任务 ID：a1b2c3d4
```

审批原因显示“需要批准操作”，问题显示“需要回答问题”或“需要确认方案”。不显示命令和问题全文。

### 12.2 完成

```text
🟢 任务完成

项目：power-trader-edu
任务：生成宣传讲解 HTML PPT
位置：Codex Desktop
完成：14:35
任务 ID：a1b2c3d4
```

卡片不提供远程审批按钮，不发送任务结果全文。

## 13. 投递、重试与延迟

- 正常事件通过 Socket 立即处理，目标 3 秒内送达；
- outbox 恢复扫描间隔 500ms；
- 飞书失败按 1 秒、5 秒、20 秒重试；
- `cli2im` 重启后继续待投递事件；
- “延迟送达”从结构化事件发生时间计算；
- 不再使用迟到的 JSONL `task_complete` 时间判断延迟；
- 完成事件缺少项目名或任务名时保持待处理，不降级成“未命名任务”。

## 14. 隐私与安全

- Hook、MCP 服务、Socket 和 outbox 都只接受明确允许字段；
- Hook 输入不写日志；
- 原始 prompt 只在 Hook 进程内短暂存在；
- 工具输入、命令、代码、Diff、完整路径、飞书 ID 和环境变量不写通知日志；
- MCP 状态工具不能自定义项目名和任务名；
- 插件 Hook 必须完成 Codex 信任确认；
- 不新增外部 API、账号或凭据；
- 不修改现有原生通知配置。

## 15. 切换方案

不长期双轨运行，避免重复卡片和继续产生错误绿色提醒。

上线顺序：

1. 完成插件、Hooks、MCP 服务、任务状态机和 outbox 的自动化测试；
2. 构建插件和 `cli2im`，但保持结构化通知投递开关关闭；
3. 备份 `cli2im` 数据库、生产构建、Codex 配置和个人插件目录；
4. 安装插件，完成 Hook 信任确认；
5. 用本地假适配器验证结构化事件链路；
6. 原子启用结构化状态源，同时关闭 JSONL `task_complete -> completed`；
7. 重启 `com.cli2im.bridge`；
8. 实测橙色、绿色、普通 Stop 不误报、outbox 恢复；
9. 回读飞书卡片和本地投递状态。

JSONL 中精确的 `request_user_input` 可保留为等待提醒的恢复信号。它不能创建绿色完成事件。

## 16. 测试

### 16.1 单元测试

- Hook 输入字段白名单和 8KB 上限；
- prompt、路径和凭据脱敏；
- 新任务、等待后恢复、新任务切换；
- 所有状态流转和非法流转；
- `COMPLETED` 终态；
- Stop 第一次继续、第二次放行；
- 子代理事件不能完成主任务；
- Socket 与 outbox 双写去重；
- 飞书重试和延迟计算；
- 成功投递后的隐私清理。

### 16.2 集成测试

- `UserPromptSubmit -> task_started`；
- `mark_waiting -> PostToolUse -> 橙色卡片`；
- `mark_completed -> PostToolUse -> 绿色卡片`；
- `PermissionRequest -> 橙色卡片`；
- Stop 无状态时只继续一次；
- `task_complete`、普通 final answer 和方案确认不能触发绿色；
- `cli2im` 停机期间写入 outbox，恢复后只补发一次；
- 重启后任务 ID、项目名和任务名不串线。

### 16.3 生产验收

1. 触发一次真实等待确认，3 秒内收到橙色卡片；
2. 完成一次真实交付和验证，3 秒内收到绿色卡片；
3. 结束一次没有结构化状态的回合，确认不会出现绿色卡片；
4. 验证 Stop 只自动继续一次；
5. 暂停 `cli2im`，产生一个测试事件，恢复服务后确认 outbox 补发且不重复；
6. 确认每张卡片均有正确项目名和任务名；
7. 确认原生通知仍开启；
8. 运行 `npm test`、`npm run typecheck`、`npm run build`。

## 17. 回滚

回滚优先保证不误报：

1. 关闭结构化飞书通知开关；
2. 恢复上一版 `cli2im` 构建和数据库备份；
3. 保留原生 Codex 通知；
4. 不自动恢复 JSONL 完成提醒；
5. 已安装插件和备份不删除，除非用户另行确认。

回滚后审批 Hook 可以继续保留；完成提醒保持关闭，直到结构化链路恢复。

## 18. 验收标准

- 没有成功的 `mark_completed`，绝不发送绿色提醒；
- `task_complete`、Stop、助手文本和子代理结束都不能产生绿色提醒；
- 明确等待和明确完成正常情况下 3 秒内送达；
- Stop 最多自动继续一次；
- 每张卡片都有正确项目名和任务名；
- 断线、重启和重复事件不会漏记、重复或串任务；
- 不持久化原始 prompt、完整路径、命令、代码、日志或凭据；
- 飞书只使用现有 `codexbot` 私聊；
- 原生通知保持开启；
- 自动化测试、类型检查、构建和生产验收全部通过。

## 19. 官方能力依据

Codex Hooks 文档确认：

- `UserPromptSubmit` 提供 `session_id`、`turn_id`、`cwd` 和 `prompt`；
- `PostToolUse` 支持匹配 MCP 工具调用；
- `PermissionRequest` 是独立生命周期事件；
- `Stop` 提供 `turn_id`、`stop_hook_active`，并可用 `decision: block` 让 Codex 自动继续一次；
- transcript 格式不是稳定 Hook 接口，不能作为状态协议。

参考：<https://learn.chatgpt.com/docs/hooks>
