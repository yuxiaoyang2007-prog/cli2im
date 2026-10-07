/** Ambient credentials belong to the bridge, not to every agent it starts. */
export type ChildProvider = 'claude-code' | 'codex' | 'gemini' | 'agy' | 'zcode' | 'kimi-work' | 'local-tool';

const RUNTIME_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY',
  'CLI2IM_NETWORK_REQUIRED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
]);

const PROVIDER_KEYS: Record<ChildProvider, readonly string[]> = {
  'claude-code': [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL', 'DISABLE_AUTOUPDATER',
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME', 'CTI_CODEX_API_KEY', 'CTI_CODEX_BASE_URL', 'CTI_CODEX_GENERATED_IMAGES_DIR'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_CLI_HOME'],
  agy: ['ANTIGRAVITY_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
  zcode: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'ZCODE_HOME', 'ZCODE_CONFIG_DIR'],
  'kimi-work': ['KIMI_API_KEY', 'KIMI_CODE_API_KEY', 'KIMI_SHARE_DIR', 'DAIMON_CONFIG_PATH', 'DAIMON_BUNDLE_NODE_BIN'],
  'local-tool': [],
};

const BRIDGE_SECRET_KEY = /^(?:(?:CTI|CLI2IM)_.*(?:TOKEN|SECRET|PASSWORD)|(?:FEISHU|LARK|TELEGRAM)(?:_.*)?(?:TOKEN|SECRET)|DASHSCOPE_API_KEY)$/i;
const NETWORK_POLICY_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'CLI2IM_NETWORK_REQUIRED',
]);

/** Explicit per-agent overrides are intentional grants; inherited values are allowlisted. */
export function buildChildEnv(
  provider: ChildProvider,
  overrides: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set([...RUNTIME_KEYS, ...PROVIDER_KEYS[provider]]);
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = inherited[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (inherited.CLI2IM_NETWORK_REQUIRED === '1' && NETWORK_POLICY_KEYS.has(key)) continue;
    if (!BRIDGE_SECRET_KEY.test(key)) result[key] = value;
  }
  return result;
}
