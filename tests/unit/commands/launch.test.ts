/**
 * Tests for browser launch command
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args)
}));

// Mock fs.existsSync (override the global fs mock from setup.ts)
const mockExistsSync = vi.fn();
vi.mock('fs', async () => {
  return {
    writeFileSync: vi.fn(),
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: vi.fn()
  };
});

describe('Launch Command', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset platform to darwin by default
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    // Restore original platform
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function createMockProcess(): EventEmitter & { unref: () => void } {
    const proc = new EventEmitter() as EventEmitter & { unref: () => void };
    proc.unref = vi.fn();
    return proc;
  }

  it('should launch Chrome with correct args', async () => {
    const capture = captureConsoleOutput();
    mockExistsSync.mockReturnValue(true);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    // Dynamically import to pick up mocks
    const { launchBrowser } = await import('../../../src/commands/launch.js');

    const launchPromise = launchBrowser({ port: 9222, browser: 'chrome' });

    // Emit spawn event to simulate successful process start
    setTimeout(() => proc.emit('spawn'), 5);

    await launchPromise;

    const logs = capture.getLogs();
    capture.restore();

    // Verify spawn was called with correct args
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [path, args] = mockSpawn.mock.calls[0];
    expect(path).toContain('Google Chrome');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');

    // Verify success output
    expect(logs).toHaveLength(1);
    const result = JSON.parse(logs[0]);
    expect(result.success).toBe(true);
    expect(result.message).toBe('Google Chrome launched');
    expect(result.data.port).toBe(9222);
  });

  it('should add stealth flags for Helium', async () => {
    const capture = captureConsoleOutput();
    mockExistsSync.mockReturnValue(true);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const { launchBrowser } = await import('../../../src/commands/launch.js');

    const launchPromise = launchBrowser({ port: 9222, browser: 'helium', stealth: true });

    setTimeout(() => proc.emit('spawn'), 5);

    await launchPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('--fingerprinting-client-rects-noise');
    expect(args).toContain('--fingerprinting-canvas-measuretext-noise');
    expect(args).toContain('--fingerprinting-canvas-image-data-noise');

    const logs = capture.getLogs();
    capture.restore();

    const result = JSON.parse(logs[0]);
    expect(result.data.stealth).toBe(true);
  });

  it('should error when browser not found', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    mockExistsSync.mockReturnValue(false);

    const { launchBrowser } = await import('../../../src/commands/launch.js');

    try {
      await launchBrowser({ port: 9222, browser: 'chrome' });
    } catch {
      // Expected process.exit
    }

    expect(exitMock.exitCode).toBe(1);
    const errors = capture.getErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('BROWSER_NOT_FOUND:');
    expect(errors[0]).toContain('not found at expected location');

    capture.restore();
    exitMock.restore();
  });

  it('should error on non-macOS platform', async () => {
    const capture = captureConsoleOutput();
    const exitMock = mockProcessExit();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const { launchBrowser } = await import('../../../src/commands/launch.js');

    try {
      await launchBrowser({ port: 9222, browser: 'chrome' });
    } catch {
      // Expected process.exit
    }

    expect(exitMock.exitCode).toBe(1);
    const errors = capture.getErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('UNSUPPORTED_PLATFORM:');
    expect(errors[0]).toContain('only supported on macOS');

    capture.restore();
    exitMock.restore();
  });
});
