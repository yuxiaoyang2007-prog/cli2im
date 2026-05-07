import { describe, it, expect } from 'vitest';
import { parseBridgeCommand, isBridgeCommand } from '../src/pipeline.js';

describe('isBridgeCommand', () => {
  it('recognizes bridge commands', () => {
    expect(isBridgeCommand('/new')).toBe(true);
    expect(isBridgeCommand('/list')).toBe(true);
    expect(isBridgeCommand('/switch abc')).toBe(true);
    expect(isBridgeCommand('/cwd ~/projects')).toBe(true);
    expect(isBridgeCommand('/status')).toBe(true);
    expect(isBridgeCommand('/stop')).toBe(true);
    expect(isBridgeCommand('/kill')).toBe(true);
    expect(isBridgeCommand('/resume ses_abc')).toBe(true);
    expect(isBridgeCommand('/handoff')).toBe(true);
    expect(isBridgeCommand('/force-approve')).toBe(true);
    expect(isBridgeCommand('/model opus')).toBe(true);
  });

  it('does not recognize CLI passthrough commands', () => {
    expect(isBridgeCommand('/compact')).toBe(false);
    expect(isBridgeCommand('/review')).toBe(false);
    expect(isBridgeCommand('/cost')).toBe(false);
    expect(isBridgeCommand('/doctor')).toBe(false);
  });

  it('does not recognize plain messages', () => {
    expect(isBridgeCommand('hello')).toBe(false);
    expect(isBridgeCommand('help me fix this')).toBe(false);
  });
});

describe('parseBridgeCommand', () => {
  it('parses /new', () => {
    const cmd = parseBridgeCommand('/new');
    expect(cmd).toEqual({ command: 'new', args: [] });
  });

  it('parses /switch with args', () => {
    const cmd = parseBridgeCommand('/switch ses_abc123');
    expect(cmd).toEqual({ command: 'switch', args: ['ses_abc123'] });
  });

  it('parses /cwd with path', () => {
    const cmd = parseBridgeCommand('/cwd ~/projects/newsradar');
    expect(cmd).toEqual({ command: 'cwd', args: ['~/projects/newsradar'] });
  });

  it('parses /model with name', () => {
    const cmd = parseBridgeCommand('/model claude-sonnet-4-20250514');
    expect(cmd).toEqual({ command: 'model', args: ['claude-sonnet-4-20250514'] });
  });

  it('returns null for non-bridge commands', () => {
    expect(parseBridgeCommand('/compact')).toBeNull();
    expect(parseBridgeCommand('hello')).toBeNull();
  });
});
