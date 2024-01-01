import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleUncaughtException, handleUnhandledRejection } from '../src/index.js';

describe('process error handlers', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.useFakeTimers();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('forces non-zero process exit after uncaught exceptions', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never));

    handleUncaughtException(new Error('boom'));

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('forces non-zero process exit after unhandled promise rejections', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never));

    handleUnhandledRejection('async boom');

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
