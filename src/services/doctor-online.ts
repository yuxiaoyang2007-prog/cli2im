import { scrubLog } from '../security/logging.js';
import type { AppConfig } from '../types.js';

export interface OnlineProbeResult {
  botName: string;
  platform: 'feishu' | 'telegram';
  ok: boolean;
  latencyMs: number;
  detail: string;
}

const PROBE_TIMEOUT_MS = 5_000;

function sanitizeDetail(text: string, secrets: Array<string | undefined>): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      clean = clean.split(secret).join('[REDACTED]');
    }
  }
  return scrubLog(clean).slice(0, 140);
}

async function probeFeishuBot(
  botName: string,
  appId: string,
  appSecret: string,
  fetchImpl: typeof fetch,
): Promise<OnlineProbeResult> {
  const startedAt = Date.now();
  try {
    const resp = await fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    const latencyMs = Date.now() - startedAt;
    const data = (await resp.json().catch(() => ({}))) as {
      code?: unknown;
      msg?: unknown;
      tenant_access_token?: unknown;
    };
    const tokenOk = typeof data.tenant_access_token === 'string' && data.tenant_access_token.length > 0;
    if (resp.ok && data.code === 0 && tokenOk) {
      return {
        botName,
        platform: 'feishu',
        ok: true,
        latencyMs,
        detail: `tenant token verified (${latencyMs}ms)`,
      };
    }
    const errMsg = sanitizeDetail(
      typeof data.msg === 'string' ? data.msg : `HTTP ${resp.status}`,
      [appId, appSecret, typeof data.tenant_access_token === 'string' ? data.tenant_access_token : undefined],
    );
    return {
      botName,
      platform: 'feishu',
      ok: false,
      latencyMs,
      detail: errMsg || `probe failed (${latencyMs}ms)`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      botName,
      platform: 'feishu',
      ok: false,
      latencyMs,
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err), [appId, appSecret]),
    };
  }
}

async function probeTelegramBot(
  botName: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<OnlineProbeResult> {
  const startedAt = Date.now();
  try {
    const resp = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: unknown;
      description?: unknown;
      result?: { username?: unknown };
    };
    if (resp.ok && data.ok === true) {
      const username = typeof data.result?.username === 'string' && data.result.username
        ? `@${data.result.username}`
        : 'verified';
      return {
        botName,
        platform: 'telegram',
        ok: true,
        latencyMs,
        detail: `${username} (${latencyMs}ms)`,
      };
    }
    const errMsg = sanitizeDetail(
      typeof data.description === 'string' ? data.description : `HTTP ${resp.status}`,
      [token],
    );
    return {
      botName,
      platform: 'telegram',
      ok: false,
      latencyMs,
      detail: errMsg || `probe failed (${latencyMs}ms)`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      botName,
      platform: 'telegram',
      ok: false,
      latencyMs,
      detail: sanitizeDetail(err instanceof Error ? err.message : String(err), [token]),
    };
  }
}

export async function runOnlineDoctorProbes(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OnlineProbeResult[]> {
  const tasks: Array<Promise<OnlineProbeResult>> = [];
  for (const [botName, bot] of Object.entries(config.bots)) {
    if (bot.enabled === false) continue;
    if (bot.platform === 'feishu' && bot.feishu?.appId && bot.feishu?.appSecret) {
      tasks.push(probeFeishuBot(botName, bot.feishu.appId, bot.feishu.appSecret, fetchImpl));
    } else if (bot.platform === 'telegram' && bot.telegram?.token) {
      tasks.push(probeTelegramBot(botName, bot.telegram.token, fetchImpl));
    } else {
      tasks.push(
        Promise.resolve({
          botName,
          platform: bot.platform,
          ok: false,
          latencyMs: 0,
          detail: 'missing platform credentials',
        }),
      );
    }
  }
  return Promise.all(tasks);
}

export function formatOnlineDoctorSection(results: OnlineProbeResult[]): string {
  const lines = ['== 在线连通性探测 =='];
  for (const item of results) {
    const tag = item.ok ? '[通过]' : '[失败]';
    lines.push(`${tag} ${item.botName} (${item.platform}): ${item.detail}`);
  }
  return lines.join('\n');
}
