export function toFeishuMarkdown(content: string): string {
  let result = content;

  result = result.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)');

  return result;
}

export function buildPermissionBlockedCard(command: string, _requestId: string): string {
  return [
    '**已拦截危险操作**',
    '',
    '```',
    command,
    '```',
    '',
    '回复 `/force-approve` 确认执行（60 秒超时自动拒绝）',
  ].join('\n');
}

export function buildHandoffNotification(params: {
  sessionId: string;
  workDir: string;
  agentName: string;
}): string {
  return [
    '**已接管会话**',
    '',
    `- Session: \`${params.sessionId}\``,
    `- 项目: \`${params.workDir}\``,
    `- Agent: ${params.agentName}`,
    '',
    '发消息继续推进',
  ].join('\n');
}

export function buildHandoffReleaseNotification(params: {
  sessionId: string;
  resumeCommand: string;
}): string {
  return [
    '**会话已释放**',
    '',
    '在终端运行:',
    '```',
    params.resumeCommand,
    '```',
  ].join('\n');
}

export function buildCrashNotification(code: number | null): string {
  return `**Agent 进程异常退出** (code: ${code ?? 'unknown'})\n\n发送新消息重新启动`;
}
