const MAX_INPUT_LENGTH = 50000;
const BLOCKED_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys'];

export function validateWorkingDirectory(path: string): boolean {
  if (path.includes('..')) return false;

  if (path.startsWith('~')) return true;

  for (const prefix of BLOCKED_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return false;
  }

  return path.startsWith('/Users/') || path.startsWith('/home/');
}

export function sanitizeInput(input: string): string {
  let stripped = input;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<\s*\/?\s*cti-(?:sender|relay)\b[^>]*\/?\s*>/gi, '');
  } while (stripped !== previous);

  const trimmed = stripped.trim();
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return trimmed.slice(0, MAX_INPUT_LENGTH);
  }
  return trimmed;
}
