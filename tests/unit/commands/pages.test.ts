/**
 * Tests for page management commands
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as pages from '../../../src/commands/pages.js';
import { CDPContext } from '../../../src/context.js';
import { installMockFetch } from '../../mocks/fetch.mock.js';
import { MockWebSocket } from '../../mocks/websocket.mock.js';
import { captureConsoleOutput, mockProcessExit } from '../../helpers.js';

describe('Pages Commands', () => {
  beforeEach(() => {
    installMockFetch();
  });

  describe('listPages', () => {
    it('should output NDJSON list of pages', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.listPages(context);

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(4);

      const page1 = JSON.parse(logs[0]);
      expect(page1).toEqual({
        id: 'page1',
        title: 'Example Domain',
        url: 'https://example.com',
        type: 'page'
      });
    });

    it('should exit on error', async () => {
      installMockFetch({ failFetch: true });
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.listPages(context);
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);

      expect(errors[0]).toContain('LIST_PAGES_FAILED:');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('newPage', () => {
    it('should create page without URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.newPage(context);

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('new-page-123');
      expect(result.data.url).toBe('about:blank');
    });

    it('should create page with URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.newPage(context, 'https://example.com');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.data.url).toBe('https://example.com');
    });
  });

  describe('navigate', () => {
    it('should navigate to URL', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'https://example.com', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.action).toBe('https://example.com');
    });

    it('should navigate back', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'back', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should navigate forward', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'forward', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should reload page', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.navigate(context, 'reload', 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
    });

    it('should handle invalid page', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.navigate(context, 'reload', 'nonexistent');
      } catch (e) {
        // Expected process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('NAVIGATE_FAILED:');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('closePage', () => {
    it('should close page by ID', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.closePage(context, 'page1');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('page1');
    });

    it('should close page by title', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();

      await pages.closePage(context, 'GitHub Issues');

      const logs = capture.getLogs();
      capture.restore();

      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('GitHub Issues');
    });

    it('should error when title matches multiple pages', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.closePage(context, 'GitHub');
      } catch {
        // Expected exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('CLOSE_PAGE_FAILED:');
      expect(errors[0]).toContain('Multiple pages matched');

      capture.restore();
      exitMock.restore();
    });
  });

  describe('resizeWindow', () => {
    it('should resize window with provided dimensions', async () => {
      const capture = captureConsoleOutput();
      const context = new CDPContext();
      const originalConnect = context.connect.bind(context);
      let sentMessages: any[] = [];

      context.connect = async (page) => {
        const ws = await originalConnect(page) as MockWebSocket;
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          const message = JSON.parse(data);
          sentMessages.push(message);
          originalSend(data);
        };
        return ws;
      };

      await pages.resizeWindow(context, 'page1', { width: 1400, height: 900 });

      const logs = capture.getLogs();
      capture.restore();

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]);
      expect(result.success).toBe(true);
      expect(result.data.page).toBe('page1');
      expect(result.data.width).toBe(1400);
      expect(result.data.height).toBe(900);
      expect(result.data.state).toBe('normal');

      const getWindowMessage = sentMessages.find(msg => msg.method === 'Browser.getWindowForTarget');
      expect(getWindowMessage).toBeDefined();
      expect(getWindowMessage.params.targetId).toBe('page1');

      const setBoundsMessage = sentMessages.find(msg => msg.method === 'Browser.setWindowBounds');
      expect(setBoundsMessage).toBeDefined();
      expect(setBoundsMessage.params.bounds.width).toBe(1400);
      expect(setBoundsMessage.params.bounds.height).toBe(900);
      expect(setBoundsMessage.params.bounds.windowState).toBe('normal');
    });

    it('should exit when page is not found', async () => {
      const capture = captureConsoleOutput();
      const exitMock = mockProcessExit();
      const context = new CDPContext();

      try {
        await pages.resizeWindow(context, 'missing-page', { width: 1200, height: 800 });
      } catch {
        // Expected due to process.exit
      }

      expect(exitMock.exitCode).toBe(1);
      const errors = capture.getErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('RESIZE_WINDOW_FAILED:');

      capture.restore();
      exitMock.restore();
    });
  });
});
