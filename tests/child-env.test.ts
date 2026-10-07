import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../src/security/child-env.js';

describe('agent child environment boundary', () => {
  const inherited = {
    PATH: '/safe/bin', HOME: '/home/test', HTTPS_PROXY: 'http://127.0.0.1:7890',
    NODE_USE_ENV_PROXY: '1', CLI2IM_NETWORK_REQUIRED: '1',
    FEISHU_APP_SECRET: 'bridge-secret', TELEGRAM_BOT_TOKEN: 'bot-token',
    DASHSCOPE_API_KEY: 'speech-key', UNKNOWN_VENDOR_SECRET: 'other-secret',
    OPENAI_API_KEY: 'codex-key', ANTHROPIC_API_KEY: 'claude-key',
    CODEX_HOME: '/home/test/.codex', NODE_OPTIONS: '--require=/untrusted.js',
  };

  it('preserves the selected provider and runtime without unrelated ambient credentials', () => {
    const env = buildChildEnv('codex', {}, inherited);
    expect(env).toMatchObject({
      PATH: '/safe/bin', HOME: '/home/test', OPENAI_API_KEY: 'codex-key',
      CODEX_HOME: '/home/test/.codex', HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1', CLI2IM_NETWORK_REQUIRED: '1',
    });
    for (const key of ['FEISHU_APP_SECRET', 'TELEGRAM_BOT_TOKEN', 'DASHSCOPE_API_KEY', 'UNKNOWN_VENDOR_SECRET', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(key);
    }
    expect(buildChildEnv('claude-code', {}, inherited).ANTHROPIC_API_KEY).toBe('claude-key');
    expect(buildChildEnv('claude-code', {}, inherited)).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('retains explicit per-bot account and sender context, but blocks bridge credentials', () => {
    const env = buildChildEnv('agy', {
      LARKSUITE_CLI_CONFIG_DIR: '/bot/account', CTI_SENDER_USER_ID: 'sender',
      MY_EXPLICIT_PROVIDER_KEY: 'scoped-key', FEISHU_APP_SECRET: 'do-not-forward',
      CTI_API_TOKEN: 'control-secret', DASHSCOPE_API_KEY: 'speech-secret',
    }, inherited);
    expect(env).toMatchObject({ LARKSUITE_CLI_CONFIG_DIR: '/bot/account', CTI_SENDER_USER_ID: 'sender', MY_EXPLICIT_PROVIDER_KEY: 'scoped-key' });
    expect(env).not.toHaveProperty('FEISHU_APP_SECRET');
    expect(env).not.toHaveProperty('CTI_API_TOKEN');
    expect(env).not.toHaveProperty('DASHSCOPE_API_KEY');
  });

  it('does not grant provider credentials to local conversion tools', () => {
    expect(buildChildEnv('local-tool', {}, inherited)).not.toHaveProperty('OPENAI_API_KEY');
    expect(buildChildEnv('local-tool', {}, inherited)).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('does not let a per-agent override weaken the required network policy', () => {
    const env = buildChildEnv('codex', {
      HTTPS_PROXY: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*', NODE_USE_ENV_PROXY: '0', CLI2IM_NETWORK_REQUIRED: '0',
    }, inherited);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.CLI2IM_NETWORK_REQUIRED).toBe('1');
    expect(env.NO_PROXY).not.toBe('*');
    expect(env.no_proxy).not.toBe('*');
  });
});
