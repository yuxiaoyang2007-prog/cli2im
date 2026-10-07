import { readFile, writeFile, rename, copyFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';

/** Preserve comments/env references; never write expanded secrets back to YAML. */
export async function saveBotEnabled(configPath: string, botName: string, enabled: boolean): Promise<void> {
  const raw = await readFile(configPath, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length || !doc.hasIn(['bots', botName])) throw new Error('机器人配置不存在或不可解析');
  doc.setIn(['bots', botName, 'enabled'], enabled);
  const backup = `${configPath}.before-bot-update`;
  await copyFile(configPath, backup);
  await chmod(backup, 0o600);
  const temp = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(temp, String(doc), { mode: 0o600, flag: 'wx' });
  await rename(temp, configPath);
}
