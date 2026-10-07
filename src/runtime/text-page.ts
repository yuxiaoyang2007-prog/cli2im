/** Keep explicit recovery/diagnostic replies below both platforms' message limits. */
export function textPage(text: string, pageArg: string | undefined, command: string): string {
  const pages: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 2800, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pages.push(text.slice(offset, end));
    offset = end;
  }
  if (!pages.length) pages.push('');
  const requested = pageArg === undefined ? 1 : Number(pageArg);
  if (!Number.isInteger(requested) || requested < 1 || requested > pages.length) {
    return `页码无效。用法：/${command} <页码>，共 ${pages.length} 页。`;
  }
  const footer = pages.length > 1
    ? `\n\n第 ${requested}/${pages.length} 页${requested < pages.length ? `；下一页：/${command} ${requested + 1}` : ''}`
    : '';
  return pages[requested - 1] + footer;
}
