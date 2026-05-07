const MARKDOWN_V2_SPECIALS = new Set(['_', '*', '[', ']', '(', ')', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']);

export function toTelegramMarkdownV2(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text.startsWith('```', index)) {
      const end = text.indexOf('```', index + 3);
      if (end === -1) {
        result += text.slice(index);
        break;
      }
      result += text.slice(index, end + 3);
      index = end + 3;
      continue;
    }

    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end === -1) {
        result += text[index];
        index += 1;
        continue;
      }
      result += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    const char = text[index];
    const next = text[index + 1];
    if (char === '\\' && next && MARKDOWN_V2_SPECIALS.has(next)) {
      result += char + next;
      index += 2;
      continue;
    }

    result += MARKDOWN_V2_SPECIALS.has(char) ? `\\${char}` : char;
    index += 1;
  }

  return result;
}
