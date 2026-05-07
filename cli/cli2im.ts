import { parseArgs } from 'node:util';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3900;

async function main(): Promise<void> {
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
