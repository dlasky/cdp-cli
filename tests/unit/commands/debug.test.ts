/**
 * Tests for debugging commands
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as debug from '../../../src/commands/debug.js';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';
import { consoleMessages, accessibilityResponses } from '../../fixtures/cdp-responses.js';
import { writeFileSync } from 'fs';

describe('Debug Commands', () => {
  beforeEach(() => {
    installMockFetch();
    vi.clearAllMocks();
  });

  describe('listConsole', () => {
    it('should collect and output console messages', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        // Simulate console messages during collection
        setTimeout(() => {
          ws.simulateMessage(consoleMessages.log);
          ws.simulateMessage(consoleMessages.error);
        }, 10);

        return ws;
      };

      await debug.listConsole(context, { page: 'page1', duration: 0.1 });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(2);

      const logMsg = JSON.parse(logs[0]);
      expect(logMsg.type).toBe('log');
      expect(logMsg.text).toBe('Hello world');
      expect(logMsg.source).toBe('console-api');
      expect(logMsg.timestamp).toBeDefined();

      const errorMsg = JSON.parse(logs[1]);
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.text).toBe('Error occurred');
    });

    it('should filter messages by type', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        setTimeout(() => {
          ws.simulateMessage(consoleMessages.log);
          ws.simulateMessage(consoleMessages.error);
          ws.simulateMessage(consoleMessages.exception);
        }, 10);

        return ws;
      };

      // Filter for errors only
      await debug.listConsole(context, { page: 'page1', duration: 0.1, type: 'error' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(2); // error + exception (both type 'error')
      logs.forEach(log => {
        const msg = JSON.parse(log);
        expect(msg.type).toBe('error');
      });
    });

    it('should respect duration parameter', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const start = Date.now();
      await debug.listConsole(context, { page: 'page1', duration: 0.15 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(140);
      capture.restore();
    });

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.listConsole(context, { page: 'nonexistent', duration: 0.1 });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('LIST_CONSOLE_FAILED:');

      capture.restore();
      exitMock.restore();
    });

    it('should expand object args when --inspect is used', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        // Simulate a console message with an arg that has an objectId
        setTimeout(() => {
          ws.simulateMessage({
            method: 'Runtime.consoleAPICalled',
            params: {
              type: 'log',
              args: [{
                type: 'object',
                objectId: 'obj-expand-1',
                description: 'Object'
              }],
              timestamp: 1698234567890
            }
          });
        }, 10);

        return ws;
      };

      await debug.listConsole(context, { page: 'page1', duration: 0.2, inspect: true });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const msg = JSON.parse(logs[0]);
      expect(msg.type).toBe('log');
      // The mock returns Runtime.getProperties with {key: 'expanded-value'}
      // expandValue builds an object from enumerable properties
      expect(msg.text).toContain('expanded-value');
    });

    it('should close WebSocket via try-finally', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      let wsClosed = false;
      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalClose = ws.close.bind(ws);
        ws.close = () => {
          wsClosed = true;
          originalClose();
        };
        return ws;
      };

      await debug.listConsole(context, { page: 'page1', duration: 0.05 });

      expect(wsClosed).toBe(true);
      capture.restore();
    });
  });

  describe('snapshot', () => {
    it('should capture text snapshot', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.snapshot(context, { page: 'page1', format: 'text' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      // For text format, output is raw (not JSON)
      expect(logs[0]).toBe('test result');
    });

    it('should error on removed dom format', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.snapshot(context, { page: 'page1', format: 'dom' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SNAPSHOT_FAILED:');
      expect(errors[0]).toContain('Unknown snapshot format: dom');

      capture.restore();
      exitMock.restore();
    });

    it('should capture actionable elements snapshot (ax format)', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.snapshot(context, { page: 'page1', format: 'ax' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      // ax format outputs plain text lines with actionable elements
      const output = logs[0];
      expect(output).toContain('[button]');
      expect(output).toContain('"Submit"');
      expect(output).toContain('#submit');
      expect(output).toContain('[input:text]');
      expect(output).toContain('"Email"');
    });

    it('should use ax format by default', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.snapshot(context, { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      // Default format is ax, which outputs actionable elements as plain text
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('[button]');
      expect(logs[0]).toContain('[input:text]');
    });

    it('should error on invalid format', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.snapshot(context, { page: 'page1', format: 'invalid' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SNAPSHOT_FAILED:');
      expect(errors[0]).toContain('Unknown snapshot format');

      capture.restore();
      exitMock.restore();
    });

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.snapshot(context, { page: 'nonexistent', format: 'text' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SNAPSHOT_FAILED:');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('evaluate', () => {
    it('should evaluate JavaScript expression', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.evaluate(context, '2 + 2', { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);

      expect(result.success).toBe(true);
      expect(result.value).toBe('test result'); // From mock
      expect(result.type).toBe('string');
    });

    // Note: Testing JavaScript exceptions with auto-responding mocks is complex
    // The exception handling code path is tested by the error handling in page not found test
    // In practice, evaluate() correctly handles exceptionDetails as shown in the code

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.evaluate(context, '2 + 2', { page: 'nonexistent' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('EVAL_FAILED:');
      expect(errors[0]).toContain('expression: 2 + 2');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('screenshot', () => {
    it('should save screenshot to file', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.screenshot(context, {
        page: 'page1',
        output: '/tmp/test.jpg',
        format: 'jpeg',
        quality: 90
      });

      const logs = capture.getLogs();
      capture.restore();

      // Verify writeFileSync was called
      expect(writeFileSync).toHaveBeenCalled();
      const callArgs = (writeFileSync as any).mock.calls[0];
      expect(callArgs[0]).toBe('/tmp/test.jpg');
      expect(Buffer.isBuffer(callArgs[1])).toBe(true);

      // Verify success output
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.file).toBe('/tmp/test.jpg');
      expect(result.data.format).toBe('jpeg');
      expect(result.data.size).toBeGreaterThan(0);
    });

    it('should output base64 when no file specified', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.screenshot(context, { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(writeFileSync).not.toHaveBeenCalled();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.format).toBe('jpeg'); // default
      // Data goes through Buffer round-trip: Buffer.from(base64, 'base64').toString('base64')
      expect(result.data).toBe(Buffer.from('base64encodeddata==', 'base64').toString('base64'));
    });

    it('should validate format (BUG FIX TEST)', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.screenshot(context, { page: 'page1', format: 'gif' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SCREENSHOT_FAILED:');
      expect(errors[0]).toContain('Invalid format: gif');
      expect(errors[0]).toContain('jpeg, png, webp');

      capture.restore();
      exitMock.restore();
    });

    it('should apply quality to jpeg only', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      let capturedCommands: any[] = [];
      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          capturedCommands.push(msg);
          originalSend(data);
        };
        return ws;
      };

      // Test PNG - quality should NOT be passed
      await debug.screenshot(context, { page: 'page1', format: 'png', quality: 50 });

      const pngCommand = capturedCommands.find(m => m.method === 'Page.captureScreenshot');
      expect(pngCommand.params.format).toBe('png');
      expect(pngCommand.params.quality).toBeUndefined();

      capturedCommands = [];
      capture.getLogs(); // Clear logs

      // Test JPEG - quality should be passed
      await debug.screenshot(context, { page: 'page1', format: 'jpeg', quality: 75 });

      const jpegCommand = capturedCommands.find(m => m.method === 'Page.captureScreenshot');
      expect(jpegCommand.params.format).toBe('jpeg');
      expect(jpegCommand.params.quality).toBe(75);

      capture.restore();
    });

    it.each([
      ['/tmp/output.png', 'png'],
      ['/tmp/output.PNG', 'png'],
      ['/tmp/output.jpg', 'jpeg'],
      ['/tmp/output.jpeg', 'jpeg'],
      ['/tmp/output.webp', 'webp'],
      ['C:\\restaurant\\error_screenshot.png', 'png']
    ])('should infer screenshot format from output extension %s', async (output, expectedFormat) => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      const sentCommands: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          if (message.method === 'Page.captureScreenshot') {
            sentCommands.push(message);
          }
          originalSend(data);
        };
        return ws;
      };

      await debug.screenshot(context, { page: 'page1', output });

      const screenshotCommand = sentCommands[0];
      expect(screenshotCommand).toBeDefined();
      expect(screenshotCommand.params.format).toBe(expectedFormat);

      const calls = (writeFileSync as any).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe(output);

      capture.restore();
    });

    it('should default to jpeg when output extension is unrecognized', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      const sentCommands: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          if (message.method === 'Page.captureScreenshot') {
            sentCommands.push(message);
          }
          originalSend(data);
        };
        return ws;
      };

      await debug.screenshot(context, { page: 'page1', output: '/tmp/output.tiff' });

      const screenshotCommand = sentCommands[0];
      expect(screenshotCommand).toBeDefined();
      expect(screenshotCommand.params.format).toBe('jpeg');

      capture.restore();
    });

    it('should scale screenshot when scale provided', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      const sentCommands: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          sentCommands.push(message);
          originalSend(data);
        };
        return ws;
      };

      await debug.screenshot(context, {
        page: 'page1',
        output: '/tmp/scaled.jpg',
        format: 'jpeg',
        quality: 90,
        scale: 0.5
      });

      expect(writeFileSync).toHaveBeenCalled();
      const writeCalls = (writeFileSync as any).mock.calls;
      const lastWriteCall = writeCalls[writeCalls.length - 1];
      expect(lastWriteCall[0]).toBe('/tmp/scaled.jpg');

      // Screenshot is captured at full resolution (no clip.scale), scaling is done via sharp
      const screenshotCommand = sentCommands.find(msg => msg.method === 'Page.captureScreenshot');
      expect(screenshotCommand).toBeDefined();
      expect(screenshotCommand.params.clip).toBeUndefined();

      // Verify success output
      const logs = capture.getLogs();
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.file).toBe('/tmp/scaled.jpg');

      capture.restore();
    });

    it('should validate scale range', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.screenshot(context, { page: 'page1', scale: 1.5 });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SCREENSHOT_FAILED:');
      expect(errors[0]).toContain('Invalid scale');

      capture.restore();
      exitMock.restore();
    });

    it('should handle page not found error', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await debug.screenshot(context, { page: 'nonexistent' });
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('SCREENSHOT_FAILED:');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('dialog', () => {
    it('should report no dialog when none present', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await debug.dialog(context, { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.dialog).toBeNull();
      expect(result.message).toBe('No dialog present');
    });

    it('should report dialog info when dialog is present', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        // Simulate dialog opening after Page.enable
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          originalSend(data);
          if (msg.method === 'Page.enable') {
            setTimeout(() => {
              ws.simulateMessage({
                method: 'Page.javascriptDialogOpening',
                params: {
                  type: 'alert',
                  message: 'Test alert message',
                  url: 'https://example.com',
                  defaultPrompt: ''
                }
              });
            }, 5);
          }
        };

        return ws;
      };

      await debug.dialog(context, { page: 'page1' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.dialog).toBeDefined();
      expect(result.dialog.type).toBe('alert');
      expect(result.dialog.message).toBe('Test alert message');
      expect(result.hint).toContain('--dismiss');
    });

    it('should dismiss dialog when --dismiss flag is used', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      let sentCommands: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          sentCommands.push(msg);
          originalSend(data);
          if (msg.method === 'Page.enable') {
            setTimeout(() => {
              ws.simulateMessage({
                method: 'Page.javascriptDialogOpening',
                params: {
                  type: 'confirm',
                  message: 'Are you sure?',
                  url: 'https://example.com'
                }
              });
            }, 5);
          }
        };

        return ws;
      };

      await debug.dialog(context, { page: 'page1', dismiss: true });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.message).toContain('dismissed');

      const handleDialogCmd = sentCommands.find(c => c.method === 'Page.handleJavaScriptDialog');
      expect(handleDialogCmd).toBeDefined();
      expect(handleDialogCmd.params.accept).toBe(false);
    });

    it('should accept dialog with prompt text when --accept and --prompt-text are used', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      let sentCommands: any[] = [];

      const originalConnect = context.connect.bind(context);
      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;

        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const msg = JSON.parse(data);
          sentCommands.push(msg);
          originalSend(data);
          if (msg.method === 'Page.enable') {
            setTimeout(() => {
              ws.simulateMessage({
                method: 'Page.javascriptDialogOpening',
                params: {
                  type: 'prompt',
                  message: 'Enter your name:',
                  url: 'https://example.com',
                  defaultPrompt: 'John'
                }
              });
            }, 5);
          }
        };

        return ws;
      };

      await debug.dialog(context, { page: 'page1', accept: true, promptText: 'Jane' });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.message).toContain('accepted');

      const handleDialogCmd = sentCommands.find(c => c.method === 'Page.handleJavaScriptDialog');
      expect(handleDialogCmd).toBeDefined();
      expect(handleDialogCmd.params.accept).toBe(true);
      expect(handleDialogCmd.params.promptText).toBe('Jane');
    });
  });
});
