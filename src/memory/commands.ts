import type { BotConfig } from '../types.js';
import type { BridgeCommand } from '../pipeline.js';
import { isBotAdmin } from '../security/access-policy.js';
import { textPage } from '../runtime/text-page.js';
import { samePerson, type MemoryIdentity } from './principal.js';
import { MemoryStore, type MemoryEntry, MemoryError, MemoryWriteError } from './store.js';

export interface MemoryCommandContext {
  store: MemoryStore; identity: MemoryIdentity; people: ReadonlyMap<string, string>;
  revoke: (principal: string) => Promise<void>;
}

export async function handleMemoryCommand(command: BridgeCommand, bot: BotConfig, userId: string,
  context?: MemoryCommandContext): Promise<string> {
  if (bot.memory !== true) return '该机器人未开启长期记忆';
  if (bot.isolation?.enabled !== true || !context) return '记忆功能尚未就绪';
  const { store, identity, people, revoke } = context;
  const { principal, actorKey, group } = identity;
  const authorize = (entry: MemoryEntry) => !group || samePerson(entry.createdBy, actorKey, people) || isBotAdmin(bot, userId);
  try {
    if (command.command === 'remember') {
      const entry = await store.add(principal, actorKey, command.args.join(' '));
      return `已记住 #${entry.id}`;
    }
    if (command.command === 'forget') {
      if (command.args.length !== 1) return '用法：/forget <id>';
      let confirmed = true;
      try { await store.forget(principal, parseId(command.args[0]), authorize); }
      catch (error) {
        if (!(error instanceof MemoryWriteError)) throw error;
        confirmed = false;
      }
      // Every authorized write attempt revokes once, even if publication/durability is uncertain.
      try { await revoke(principal); }
      catch {
        return confirmed ? '记忆条目与历史已删除，撤销代次已保存；部分会话清理失败，请管理员处理'
          : '删除结果未确认，部分会话清理失败，请管理员检查';
      }
      if (!confirmed) return '删除结果未确认，已重置相关对话，请管理员检查';
      return `已忘记 #${command.args[0]}；相关对话已重新开始，旧聊天记录仍保存但不会再被使用`;
    }
    const [action, id, ...text] = command.args;
    if (action === 'edit') {
      await store.edit(principal, actorKey, parseId(id), text.join(' '), authorize);
      return `已修改 #${id}；当前对话上下文仍可能含旧文本，彻底清除可用 /new`;
    }
    const document = await store.read(principal);
    if (action === 'history') {
      const entry = document.entries.find(entry => entry.id === parseId(id));
      if (!entry) throw new MemoryError('未找到该记忆条目');
      const history = entry.history.map((version, i) => `${i + 1}. ${version.at}\n${version.text}`).join('\n\n');
      return textPage(history || '暂无历史版本', text[0], `memory history ${id}`);
    }
    if (command.args.length > 1) return '用法：/memory [页] 或 /memory edit|history <id>';
    return textPage(document.entries.map(entry => `#${entry.id} ${entry.text}`).join('\n\n') || '暂无记忆', action, 'memory');
  } catch (error) {
    if (error instanceof MemoryError) return error.message;
    // Do not expose saved content, file paths, or raw filesystem errors.
    return '记忆操作失败，请管理员检查';
  }
}

function parseId(value?: string): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new MemoryError('请提供有效的记忆编号');
  return Number(value);
}
