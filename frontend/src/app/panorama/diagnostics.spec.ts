import { describe, expect, it, vi } from 'vitest';
import { createDiagnostics, diagnosticsEnabled } from './diagnostics';

describe('diagnosticsEnabled', () => {
  it('is off by default', () => {
    expect(diagnosticsEnabled('')).toBe(false);
  });

  it('is on for diag=1', () => {
    expect(diagnosticsEnabled('?diag=1')).toBe(true);
  });

  it('is off for other values', () => {
    expect(diagnosticsEnabled('?diag=0')).toBe(false);
  });
});

describe('createDiagnostics', () => {
  it('stays silent when disabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const d = createDiagnostics(false);
    d.log('anything');
    d.once('anything');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs when enabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createDiagnostics(true).log('hello', { a: 1 });
    expect(spy).toHaveBeenCalledWith('[in-world] hello {"a":1}');
    spy.mockRestore();
  });

  it('once logs a label only the first time', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const d = createDiagnostics(true);
    d.once('frame');
    d.once('frame');
    d.once('frame');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
