export interface DashboardBotRow {
  name: string;
  platform: 'feishu' | 'telegram';
  agent: string;
  model?: string;
  effort?: string;
  state: string;
  acceptsMessages: boolean;
  error?: string;
}

export interface DashboardSnapshot {
  generatedAt: number;
  uptimeMs: number;
  activeTasks: number;
  rssMb: number;
  contentGuardStatus: string;
  contentGuardBackend: string;
  networkSummary: string;
  watchTargets: number;
  bots: DashboardBotRow[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptime(uptimeMs: number): string {
  const totalSec = Math.max(0, Math.floor(uptimeMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
  const runningCount = snapshot.bots.filter((b) => b.state === 'running').length;
  const rows = snapshot.bots.map((bot) => {
    const badgeClass =
      bot.state === 'running' ? 'ok' : bot.state === 'failed' ? 'err' : 'warn';
    return `<tr>
      <td><strong>${escapeHtml(bot.name)}</strong></td>
      <td>${escapeHtml(bot.platform)}</td>
      <td>${escapeHtml(bot.agent)}</td>
      <td><code>${escapeHtml(bot.model || 'default')}</code></td>
      <td><code>${escapeHtml(bot.effort || 'default')}</code></td>
      <td><span class="badge ${badgeClass}">${escapeHtml(bot.state)}</span></td>
      <td>${bot.acceptsMessages ? 'Yes' : 'No'}</td>
      <td class="err-text">${escapeHtml(bot.error || '')}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CLI2IM Bridge Dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { margin: 24px auto; max-width: 1080px; padding: 0 16px; line-height: 1.5; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0 24px; }
    .card { border: 1px solid rgba(128,128,128,0.28); border-radius: 8px; padding: 12px 14px; }
    .label { font-size: 12px; opacity: 0.72; }
    .val { font-size: 18px; font-weight: 600; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid rgba(128,128,128,0.22); }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .badge.ok { background: rgba(22, 163, 74, 0.16); color: #16a34a; }
    .badge.warn { background: rgba(234, 179, 8, 0.18); color: #ca8a04; }
    .badge.err { background: rgba(220, 38, 38, 0.16); color: #dc2626; }
    .err-text { color: #dc2626; font-size: 12px; }
    footer { margin-top: 20px; font-size: 12px; opacity: 0.7; }
  </style>
</head>
<body>
  <h1>CLI2IM Bridge Status</h1>
  <div class="meta">
    <div class="card"><div class="label">Uptime</div><div class="val">${escapeHtml(formatUptime(snapshot.uptimeMs))}</div></div>
    <div class="card"><div class="label">Bots Running</div><div class="val">${runningCount} / ${snapshot.bots.length}</div></div>
    <div class="card"><div class="label">Active Tasks</div><div class="val">${snapshot.activeTasks}</div></div>
    <div class="card"><div class="label">Memory RSS</div><div class="val">${snapshot.rssMb} MB</div></div>
    <div class="card"><div class="label">Content Guard</div><div class="val">${escapeHtml(snapshot.contentGuardStatus)} (${escapeHtml(snapshot.contentGuardBackend)})</div></div>
    <div class="card"><div class="label">Watch Bindings</div><div class="val">${snapshot.watchTargets}</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Bot</th><th>Platform</th><th>Agent</th><th>Model</th><th>Effort</th><th>State</th><th>Accepting</th><th>Last Error</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <footer>Network: ${escapeHtml(snapshot.networkSummary)} · Updated: ${escapeHtml(new Date(snapshot.generatedAt).toISOString())}</footer>
</body>
</html>`;
}

export interface TopHealthSummary {
  uptime?: number;
  activeSessions?: number;
}

export interface TopBotEntry {
  name?: string;
  platform?: string;
  agent?: string;
  state?: string;
  acceptsMessages?: boolean;
  error?: string;
}

/** Format daemon health and bot runtime statuses for `cli2im top` without assuming optional metadata fields. */
export function formatTopReport(health: TopHealthSummary, bots: TopBotEntry[]): string {
  const uptimeSec = Math.round((health.uptime ?? 0) / 1000);
  const activeSessions = health.activeSessions ?? 0;
  const running = bots.filter((b) => b.state === 'running').length;
  const lines = [
    `CLI2IM Top | Uptime: ${uptimeSec}s | Bots: ${running}/${bots.length} running | Active tasks: ${activeSessions}`,
    'NAME            PLATFORM   STATE      ACCEPTING  ERROR',
    ...bots.map((b) => {
      const name = String(b.name ?? '-').padEnd(15);
      const platform = String(b.platform ?? '-').padEnd(10);
      const state = String(b.state ?? 'unknown').padEnd(10);
      const accepting = String(b.acceptsMessages ?? false).padEnd(10);
      const err = b.error ? String(b.error) : '-';
      return `${name} ${platform} ${state} ${accepting} ${err}`;
    }),
  ];
  return lines.join('\n');
}
