import { describe, it, expectTypeOf } from 'vitest';
import type {
  AgentPlugin,
  PlatformAdapter,
  AgentEvent,
  AppConfig,
  SessionKey,
  ToolGateResult,
} from '../src/types.js';

describe('Type definitions', () => {
  it('AgentEvent discriminated union', () => {
    const event: AgentEvent = { type: 'text', content: 'hello' };
    if (event.type === 'text') {
      expectTypeOf(event.content).toBeString();
    }
    if (event.type === 'tool_use') {
      expectTypeOf(event.id).toBeString();
      expectTypeOf(event.name).toBeString();
    }
  });

  it('SessionKey format', () => {
    const key: SessionKey = 'feishu:oc_xxx:ccbot';
    expectTypeOf(key).toBeString();
  });

  it('ToolGateResult discriminated', () => {
    const allow: ToolGateResult = { action: 'allow' };
    const block: ToolGateResult = { action: 'block', reason: 'dangerous', command: 'rm -rf /' };
    expectTypeOf(allow.action).toEqualTypeOf<'allow' | 'block'>();
    expectTypeOf(block.reason).toEqualTypeOf<string | undefined>();
  });
});
