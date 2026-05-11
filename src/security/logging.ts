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
