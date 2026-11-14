import { createRequire } from 'node:module';
// Standalone ESM bundles include CommonJS dependencies used by the local doctor.
(globalThis as typeof globalThis & { require: NodeRequire }).require = createRequire(import.meta.url);
import { parseArgs } from 'node:util';
import { loadDataDirDotEnv } from '../src/config/dotenv.js';
import { formatTopReport, type TopBotEntry, type TopHealthSummary } from '../src/services/dashboard.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3900;

async function main(): Promise<void> {
  loadDataDirDotEnv();
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'handoff') {
    await handleHandoff(args.slice(1));
    return;
  }

  if (command === 'doctor' && args[1] === 'isolation') {
    const { doctorIsolation } = await import('./isolation.js');
    process.exitCode = await doctorIsolation(args.slice(2));
    return;
  }

  if (command === 'bots' || command === 'doctor') {
    await handleManagement(command, args.slice(1));
    return;
  }

  if (command === 'notify') {
    await handleNotify(args.slice(1));
    return;
  }

  if (command === 'top') {
    await handleTop(args.slice(1));
    return;
  }

  if (command === 'config') {
    await handleConfigCommand(args.slice(1));
    return;
  }

  if (command === 'status') {
    await handleStatus();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function handleHandoff(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      bot: { type: 'string' },
      session: { type: 'string' },
      workdir: { type: 'string' },
      agent: { type: 'string', default: 'claude-code' },
      chat: { type: 'string' },
    },
  });

  if (!values.bot || !values.session || !values.workdir) {
    console.error(
      'Usage: cli2im handoff --bot <name> --session <id> --workdir <path> [--agent <name>] [--chat <id>]',
    );
    process.exit(1);
  }

  const token = process.env.CLI2IM_WEB_TOKEN;
  if (!token) {
    console.error('CLI2IM_WEB_TOKEN environment variable required');
    process.exit(1);
  }

  const body = {
    botName: values.bot,
    sessionId: values.session,
    workDir: values.workdir,
    agentName: values.agent,
    chatId: values.chat,
  };

  const resp = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/handoff/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const result = (await resp.json()) as { success?: boolean; error?: string };

  if (result.success) {
    console.log(`Handoff accepted. Session ${values.session} is now managed by ${values.bot}`);
  } else {
    console.error(`Handoff failed: ${result.error}`);
    process.exit(1);
  }
}

async function handleManagement(command: string, args: string[]): Promise<void> {
  const token = process.env.CLI2IM_WEB_TOKEN;
  if (!token) throw new Error('CLI2IM_WEB_TOKEN is required');
  if (command === 'doctor') {
    const online = args.includes('--online');
    const qs = online ? '?online=1' : '';
    const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/doctor${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Doctor request failed (${response.status})`);
    const result = await response.json();
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  const [action, name] = args;
  if (action && (!['start', 'stop', 'restart', 'reload'].includes(action) || !name)) {
    throw new Error('Usage: cli2im bots [start|stop|restart|reload <bot-name>]');
  }
  const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/bots`, {
    method: action ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(action ? { body: JSON.stringify({ name, action }) } : {}),
  });
  if (!response.ok) throw new Error(`Management request failed (${response.status})`);
  const result = await response.json();
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function handleNotify(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      bot: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string' },
      status: { type: 'string' },
      session: { type: 'string' },
      workdir: { type: 'string' },
    },
  });
  const message = (values.message ?? (await readStdinText())).trim();
  if (!message) {
    throw new Error('Usage: cli2im notify --message <text> [--bot <name>] [--title <title>] [--status completed|error|info] [--session <id>] [--workdir <dir>]');
  }
  const token = process.env.CLI2IM_WEB_TOKEN;
  if (!token) throw new Error('CLI2IM_WEB_TOKEN is required');
  const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/notify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...(values.bot ? { botName: values.bot } : {}),
      ...(values.title ? { title: values.title } : {}),
      message,
      ...(values.status ? { status: values.status } : {}),
      ...(values.session ? { sessionId: values.session } : {}),
      ...(values.workdir ? { workDir: values.workdir } : {}),
    }),
  });
  const result = (await response.json()) as { success?: boolean; botName?: string; error?: string };
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? `Notify failed (${response.status})`);
  }
  console.log(`Notification delivered via ${result.botName ?? 'bound bot'}`);
}

async function handleTop(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: 'boolean', default: false },
      interval: { type: 'string', default: '2' },
    },
  });
  const token = process.env.CLI2IM_WEB_TOKEN;
  if (!token) throw new Error('CLI2IM_WEB_TOKEN is required');
  const intervalMs = Math.max(500, Math.round((Number(values.interval) || 2) * 1000));

  const renderOnce = async (): Promise<void> => {
    const [healthResp, botsResp] = await Promise.all([
      fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`),
      fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/bots`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    if (!healthResp.ok) throw new Error(`Health check failed (${healthResp.status})`);
    if (!botsResp.ok) throw new Error(`Bots query failed (${botsResp.status})`);
    const health = (await healthResp.json()) as TopHealthSummary;
    const bots = (await botsResp.json()) as TopBotEntry[];
    const output = formatTopReport(health, Array.isArray(bots) ? bots : []);
    if (!values.once && process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    console.log(output);
  };

  await renderOnce();
  if (values.once) return;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void renderOnce().catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function handleConfigCommand(args: string[]): Promise<void> {
  if (args[0] !== 'reload') {
    throw new Error('Usage: cli2im config reload');
  }
  const token = process.env.CLI2IM_WEB_TOKEN;
  if (!token) throw new Error('CLI2IM_WEB_TOKEN is required');
  const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/config/reload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Config reload failed (${response.status})`);
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
}

async function handleStatus(): Promise<void> {
  const resp = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`);
  const status = (await resp.json()) as {
    uptime: number;
    activeSessions: number;
    bots?: string[];
  };

  console.log('CLI2IM Status:');
  console.log(`  Uptime: ${Math.round(status.uptime / 1000)}s`);
  console.log(`  Active Sessions: ${status.activeSessions}`);
  console.log(`  Bots: ${status.bots?.join(', ') ?? 'none'}`);
}

function printHelp(): void {
  console.log(`
cli2im - CLI tool for CLI2IM bridge

Commands:
  handoff   Transfer a CLI session to CLI2IM
  status    Show CLI2IM daemon status
  bots      List bots, or start/stop/restart/reload one bot
  config    Reload ~/.cli2im/config.yaml & .env without restarting bots
  notify    Push a notification card (+ 1-click resume button) to a bound /watch bot
  top       Monitor daemon uptime, active tasks, and bot states (--once)
  doctor    Inspect local runtime and configured services (--online for API probes)
  doctor isolation [--config <path>]  Run local isolation checks
  help      Show this help

Handoff:
  cli2im handoff --bot ccbot --session <session_id> --workdir ~/projects/MyProject

Environment:
  CLI2IM_WEB_TOKEN    Authentication token (required for handoff)
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
