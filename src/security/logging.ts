const DEFAULT_MAX_LOG_FIELD_LENGTH = 200;
const CONTROL_CHARS_EXCEPT_TAB = /[\x00-\x08\x0A-\x1F\x7F]/g;

export function scrubLog(value: unknown, maxLength = DEFAULT_MAX_LOG_FIELD_LENGTH): string {
  const text = stringifyLogValue(value).replace(CONTROL_CHARS_EXCEPT_TAB, '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function stringifyLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Never serialize SDK errors: Axios errors may contain credentials and request bodies. */
export function safeErrorFields(value: unknown): { code?: string | number; status?: number } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const fields: { code?: string | number; status?: number } = {};
  if (typeof record.code === 'number' && Number.isSafeInteger(record.code)) fields.code = record.code;
  if (typeof record.code === 'string' && /^(?:ENOENT|EACCES|EPERM|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_CANCELED|ERR_NETWORK|ERR_BAD_RESPONSE|ERR_BAD_REQUEST)$/.test(record.code)) {
    fields.code = record.code;
  }
  const status = record.status ?? (record.response && typeof record.response === 'object'
    ? (record.response as Record<string, unknown>).status : undefined);
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
  return fields;
}

/** SDK text, URLs, request configuration, and response bodies are deliberately omitted. */
export function createPrivateSdkLogger(component: 'feishu') {
  const log = (level: 'error' | 'warn', values: unknown[]) => {
    const fields = values.flatMap((value) => Array.isArray(value) ? value : [value])
      .map(safeErrorFields).filter((value) => Object.keys(value).length > 0);
    console[level](`[${component}] SDK ${level}`, ...fields);
  };
  return {
    error: (...values: unknown[]) => log('error', values),
    warn: (...values: unknown[]) => log('warn', values),
    info: (..._values: unknown[]) => undefined,
    debug: (..._values: unknown[]) => undefined,
    trace: (..._values: unknown[]) => undefined,
  };
}
