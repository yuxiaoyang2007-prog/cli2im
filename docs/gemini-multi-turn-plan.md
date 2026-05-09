# Gemini CLI 多轮对话方案 (v3-final)

> v1 Codex review 否决 respawnOnMessage 抽象。v2 改用 GeminiVirtualProcess，Codex 二轮 review 指出 5 个问题（双重解析、exit/close 竞态、exit 语义矛盾、initialPrompt 双发、-p 长度限制）。v3 全部修复。

## 核心设计：GeminiVirtualProcess

封装 spawn-per-turn 逻辑，对外表现为长驻 `AgentProcess`。与 `ClaudeCodeVirtualProcess` 同构。

### 对外接口

```typescript
class GeminiVirtualProcess implements AgentProcess {
  pid: number;
  sessionId: string;
  stdin: Writable;          // 接收 JSON 行消息（与 ClaudeCodePlugin 一致）
  stdout: PassThrough;      // objectMode，输出 AgentEvent 对象
  kill(signal): void;
  on(event, handler): void;
}
```

### 内部实现

```
enqueue(text)
  ├─ activeChild 存在 → push to queuedMessages[]
  └─ activeChild 为 null → runTurn(text)

runTurn(text)
  ├─ 构建 args: baseArgs + [可选 --resume <id>] + [-p text 或 stdin pipe]
  ├─ spawn(binary, args, { stdio: ['ignore'|'pipe', 'pipe', 'pipe'] })
  ├─ child.stdout → GeminiStreamParser → event → this.stdout.write(event)
  │   └─ 捕获 sessionId（status/result 事件）
  └─ child.on('close') + parser 'end' 后：
      ├─ exit code === 0 且 queue 非空 → runTurn(queue.shift())
      ├─ exit code === 0 且 queue 空 → 什么都不做（虚拟进程保持活着）
      └─ exit code !== 0 → emit error event，不退出虚拟进程（用户可继续发消息）
```

### kill() 语义（Codex v3 review blocker #1）

`kill()` 是虚拟进程的唯一终止路径，必须保证 `AgentManager` 的 exit handler 能正确清理。

```typescript
kill(signal = 'SIGTERM') {
  if (this.terminated) return;
  this.terminated = true;       // 标记终止，阻止后续 enqueue 和 error 处理
  this.queuedMessages = [];     // 清空队列
  if (this.activeChild) {
    this.activeChild.kill(signal);
    // child 的 close handler 检测到 terminated=true 后调用 emitExit
  } else {
    this.emitExit(null);        // 无活跃子进程，立刻 exit
  }
}
```

子进程 close handler 中：
```typescript
// onTurnComplete(code) 开头：
if (this.terminated) {
  this.emitExit(code);  // kill 导致的退出，直接 emit exit，不处理 error/queue
  return;
}
```

关键：`terminated` flag 阻止 kill 后的子进程 close 走进 error 发送或队列推进路径。`emitExit` 只调用一次（内部用 `exitEmitted` guard）。

### 非零退出队列处理（Codex v3 review blocker #2）

非零退出时 **清空队列**，不保留旧消息。原因：
- 旧队列消息是用户在前一个 turn 执行期间发的追问，和当前错误状态无关
- 如果保留，用户发新消息后 queue 会先 drain 旧消息（用户看不到自己刚发的消息被延迟执行），造成混乱
- ClaudeCodeVirtualProcess 在 error 路径也是直接 terminate，不 drain 队列

```typescript
// onTurnComplete(code):
if (this.terminated) {
  this.emitExit(code);
  return;
}

this.activeChild = null;

if (code !== 0 && code !== null) {
  // 非零退出：发 error，清队列，但虚拟进程保持活着
  const errMsg = this.stderrBuffer.trim() || `Gemini CLI exited with code ${code}`;
  this.stdout.write({ type: 'error', message: errMsg } as AgentEvent);
  this.queuedMessages = [];  // 清空队列
  this.stderrBuffer = '';
  return;  // 不推进队列，等用户下次发消息
}

// 正常退出：推进队列
const next = this.queuedMessages.shift();
if (next) {
  this.runTurn(next);
}
```

### 关键设计决策

#### 1. stdout 是 objectMode PassThrough

VirtualProcess 内部已经用 `GeminiStreamParser` 将 JSONL 解析为 `AgentEvent` 对象。stdout 发出的就是 `AgentEvent`，不是原始字节。

对应地，`GeminiPlugin.createStdoutParser()` 返回 `new PassThrough({ objectMode: true })`（与 `ClaudeCodePlugin` 一致），这样 `AgentManager.setupOutputStream` 的 `proc.stdout.pipe(parser)` 就是 identity pass-through，不会双重解析。

#### 2. 用 child.on('close') + parser 'end'，不用 child.on('exit')

Node.js 的 `exit` 事件可能在 stdio 流 flush 完成之前触发。如果在 `exit` 中 unpipe 和清理 parser，会丢失最后的 `result`/`init` 事件。

正确做法：

```typescript
let childClosed = false;
let childExitCode: number | null = null;
let parserDrained = false;

child.on('close', (code) => {
  childClosed = true;
  childExitCode = code;  // 可能是 null（signal kill）
  if (parserDrained) this.onTurnComplete(code);
});

parser.on('end', () => {
  parserDrained = true;
  if (childClosed) this.onTurnComplete(childExitCode);
});

// 确保 parser 在 child stdout close 后 end
child.stdout.on('close', () => parser.end());
```

注意：`code === null` 当子进程被 signal 终止时出现。dual-gate 用 `childClosed` boolean 判断 close 是否已触发，不用 `code !== null`。

`onTurnComplete(code)` 中做清理和队列推进。

#### 3. 不接受 initialPrompt，只通过 stdin

`index.ts` L533 在 spawn 后总是调用 `sendMessage()`，如果 VirtualProcess 构造函数也处理 `initialPrompt`，首条消息会发两次。

解决：VirtualProcess 构造函数不接受 initialPrompt，也不在构造时 spawn 子进程。第一条消息通过 `stdin` 写入 → `handleStdinChunk` → `enqueue` → `runTurn`（首次 spawn）。

`GeminiPlugin.spawn()` 和 `resume()` 只创建 VirtualProcess，不立刻 spawn 子进程。

对于 resume，`sessionId` 通过构造函数传入，保存到 `geminiSessionId`，首次 `runTurn` 时自动加上 `--resume`。

#### 4. -p 参数 vs stdin pipe

默认用 `-p "prompt"` 命令行参数（简单可靠，`spawn()` 不经过 shell，无注入风险）。

加长度守卫：当 prompt 字节长度 > 100KB 时，fallback 到 stdin pipe：
- stdio[0] 改为 `'pipe'`
- 不加 `-p` 参数
- spawn 后 `child.stdin.write(prompt)` + `child.stdin.end()`
- Gemini CLI 会从 stdin 读取 prompt（L15831-15837 已验证）

#### 5. 非零 exit code 处理

子进程非零退出（如 API 429、auth 失败、网络错误）：
- 收集 stderr 输出作为错误信息
- emit `{ type: 'error', message: stderr || 'Gemini CLI exited with code N' }` 到 stdout
- **不退出虚拟进程**——用户可以继续发消息（可能是临时网络错误）
- 队列中的后续消息暂停，不自动继续（避免连续失败刷屏）
- 用户下次发消息时重新触发 `enqueue` → `runTurn`

#### 6. sessionId 持久化

两处捕获，两处持久化：

**VirtualProcess 内部**（捕获）：
```typescript
// parser event handler
if (event.type === 'status' && event.sessionId) {
  this.geminiSessionId = event.sessionId;
  this.sessionId = event.sessionId;
}
if (event.type === 'result' && event.sessionId) {
  this.geminiSessionId = event.sessionId;
  this.sessionId = event.sessionId;
}
```

**AgentManager.setupOutputStream**（传递到 proc）：
```typescript
// 现有 L278：
if (event.type === 'result' && event.sessionId) {
  proc.sessionId = event.sessionId;
}
// 新增：
if (event.type === 'status' && event.sessionId) {
  proc.sessionId = event.sessionId;
}
```

**index.ts createEventHandlers.onEvent**（持久化到 DB）：
```typescript
// 现有 result 事件持久化附近新增：
if (event.type === 'status' && event.sessionId) {
  store.updateAgentSessionId(session.id, event.sessionId);
}
```

注意：VirtualProcess 内部的 `geminiSessionId` 是内部变量，用于 `--resume` 参数。`proc.sessionId` 和 DB 持久化是 manager/index 层面的，用于 session 恢复。两者值相同但用途不同。由于 VirtualProcess.stdout 发出的 status 事件会被 manager 和 index 自然处理，不需要额外同步。

## 文件变更清单

### `src/agents/gemini.ts` — 主要改动

1. **新增 `GeminiVirtualProcess` 类**（~120 行）
   - 实现 `AgentProcess` 接口
   - 内部管理消息队列 + 子进程生命周期
   - stdin 解析 JSON 行 → enqueue → runTurn
   - runTurn: spawn → pipe → parse → emit events → onTurnComplete
   - kill: terminate + kill activeChild + clear queue
   - stderr 缓冲用于错误报告

2. **修改 `GeminiPlugin`**
   - `capabilities.sessionResume` → `true`
   - `spawn()` → 返回 `new GeminiVirtualProcess(...)`
   - `resume()` → 返回带 `geminiSessionId` 的 `GeminiVirtualProcess`
   - `buildSpawnArgs()` → 只返回固定参数（不含 `-p`/`--resume`）
   - `createStdoutParser()` → `new PassThrough({ objectMode: true })`
   - `formatStdinMessage()` → `JSON.stringify({ type: 'user', message: msg }) + '\n'`
   - 删除 `createCliProcess` 私有方法

### `src/agents/manager.ts` — 2 行新增

L278 附近新增 status 事件的 sessionId 捕获（同 result 事件）。

### `src/index.ts` — ~3 行新增

`createEventHandlers` 中 status 事件的 sessionId DB 持久化。

### `src/types.ts` — 无变更

### `tests/gemini-plugin.test.ts` — 更新

- `capabilities` 期望值：`sessionResume: true`
- `buildSpawnArgs` 期望值：去掉 `--prompt` / `--resume`
- `formatStdinMessage` 期望值：JSON 行
- spawn 测试：不再期望 `script` 包裹
- 新增 `GeminiVirtualProcess` 测试组：
  - 首条消息触发 spawn
  - sessionId 从 init 事件捕获
  - 子进程退出后 resume 下条消息
  - kill 终止子进程并清空队列
  - 非零退出发 error 事件
  - 长 prompt fallback stdin pipe
