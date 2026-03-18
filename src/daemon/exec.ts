/**
 * Command execution helper - routes through daemon when available
 * Falls back to direct WebSocket connection when daemon is not running
 */

import { CDPContext, Page } from '../context.js';
import { DaemonClient } from './client.js';
import { WebSocket } from 'ws';

export interface DaemonPageInfo {
  pageId: string;
  connected: boolean;
}

export interface ExecSession {
  /** Page ID for daemon routing */
  pageId: string;
  /** WebSocket for direct connection (null if using daemon) */
  ws: WebSocket | null;
  /** Whether using daemon for execution */
  useDaemon: boolean;
  /** Execute a CDP command */
  exec: (method: string, params?: any) => Promise<any>;
  /** Check if DevTools is attached and throw if so */
  assertNoDevTools: () => Promise<void>;
  /** Check if a JavaScript dialog is blocking the page */
  assertNoDialog: () => Promise<void>;
  /** Close the session */
  close: () => void;
}

/**
 * Find a page via daemon sessions (faster than Chrome REST API)
 * Returns null if daemon not running or page not found
 */
export async function findPageViaDaemon(idOrTitle: string): Promise<DaemonPageInfo | null> {
  const daemon = new DaemonClient();

  try {
    if (!await daemon.isRunning()) {
      return null;
    }

    const sessions = await daemon.listSessions();
    if (sessions.length === 0) {
      return null;
    }

    // Exact ID match
    const byId = sessions.find(s => s.pageId === idOrTitle);
    if (byId) {
      return { pageId: byId.pageId, connected: byId.connected };
    }

    // For title matching, we'd need page info from daemon
    // For now, return null to fall back to context.findPage
    return null;
  } catch {
    return null;
  }
}

/**
 * Create an execution session for a page
 * Automatically uses daemon if available, otherwise creates direct WebSocket
 */
export async function createExecSession(
  context: CDPContext,
  page: Page
): Promise<ExecSession> {
  const daemon = new DaemonClient();

  // Check if daemon has a connected session for this page
  try {
    const sessions = await daemon.listSessions();
    const session = sessions.find(s => s.pageId === page.id && s.connected);
    if (session) {
      return {
        pageId: page.id,
        ws: null,
        useDaemon: true,
        exec: (method: string, params?: any) => daemon.execCommand(page.id, method, params),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {}, // TODO: Add daemon dialog check support
        close: () => {} // No cleanup needed for daemon
      };
    }
  } catch {
    // Daemon not running, fall through to direct connection
  }

  // Check DevTools BEFORE connecting (our connection would show as attached)
  let daemonConnectedToPage = false;
  try {
    const sessions = await daemon.listSessions();
    daemonConnectedToPage = sessions.some(s => s.pageId === page.id && s.connected);
  } catch {
    // Daemon not running
  }

  if (!daemonConnectedToPage) {
    await context.assertNoDevTools(page.id);
  }

  // Now safe to connect
  const ws = await context.connect(page);

  return {
    pageId: page.id,
    ws,
    useDaemon: false,
    exec: (method: string, params?: any) => context.sendCommand(ws, method, params),
    assertNoDevTools: async () => {}, // Already checked above
    assertNoDialog: () => context.assertNoDialog(ws),
    close: () => ws.close()
  };
}

/**
 * Create an execution session by page ID or title
 * Optimized path: uses daemon for both page lookup and command execution when available
 */
export async function createExecSessionByPageRef(
  context: CDPContext,
  pageIdOrTitle: string
): Promise<ExecSession> {
  const daemon = new DaemonClient();

  // Try daemon path first (single HTTP call for both lookup and session)
  try {
    const sessions = await daemon.listSessions();
    // Try exact ID match first
    let session = sessions.find(s => s.pageId === pageIdOrTitle && s.connected);

    // If no exact match and only one session, use it
    if (!session && sessions.length === 1 && sessions[0].connected) {
      session = sessions[0];
    }

    if (session) {
      const sessionPageId = session.pageId;
      return {
        pageId: sessionPageId,
        ws: null,
        useDaemon: true,
        exec: (method: string, params?: any) => daemon.execCommand(sessionPageId, method, params),
        assertNoDevTools: async () => {}, // Daemon handles its own connection - no check needed
        assertNoDialog: async () => {}, // TODO: Add daemon dialog check support
        close: () => {}
      };
    }
  } catch {
    // Daemon not running
  }

  // Fall back to traditional path: findPage + direct WebSocket
  const page = await context.findPage(pageIdOrTitle);

  // Check DevTools BEFORE connecting (our connection would show as attached)
  let daemonConnectedToPage = false;
  try {
    const sessions = await daemon.listSessions();
    daemonConnectedToPage = sessions.some(s => s.pageId === page.id && s.connected);
  } catch {
    // Daemon not running
  }

  if (!daemonConnectedToPage) {
    await context.assertNoDevTools(page.id);
  }

  // Now safe to connect
  const ws = await context.connect(page);

  return {
    pageId: page.id,
    ws,
    useDaemon: false,
    exec: (method: string, params?: any) => context.sendCommand(ws, method, params),
    assertNoDevTools: async () => {}, // Already checked above
    assertNoDialog: () => context.assertNoDialog(ws),
    close: () => ws.close()
  };
}

/**
 * Execute a batch of commands through daemon
 * Returns null if daemon not available
 */
export async function execBatch(
  pageId: string,
  commands: Array<{ method: string; params?: any }>
): Promise<any[] | null> {
  const daemon = new DaemonClient();

  try {
    if (!await daemon.isRunning()) {
      return null;
    }
    return await daemon.execBatch(pageId, commands);
  } catch {
    return null;
  }
}
