import { describe, expect, it } from 'vitest';
import { textPage } from '../src/runtime/text-page.js';

describe('private result and diagnostic pagination', () => {
  it('caps long replies and gives an explicit next-page command without rerunning work', () => {
    const text = 'a'.repeat(2900);
    expect(textPage(text, undefined, 'result')).toBe('a'.repeat(2800) + '\n\n第 1/2 页；下一页：/result 2');
    expect(textPage(text, '2', 'result')).toBe('a'.repeat(100) + '\n\n第 2/2 页');
    expect(textPage(text, '3', 'result')).toContain('页码无效');
  });
  it('never splits emoji surrogate pairs or exceeds the Telegram character limit', () => {
    const reply = textPage('a' + '😀'.repeat(2000), '1', 'doctor');
    expect(reply.length).toBeLessThan(4096);
    expect(reply).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(reply).toContain('/doctor 2');
  });
});
