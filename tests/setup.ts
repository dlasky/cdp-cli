/**
 * Vitest setup file
 * Runs before all tests
 */

import { vi } from 'vitest';
import { MockWebSocket } from './mocks/websocket.mock.js';
import { createMockFetch } from './mocks/fetch.mock.js';

// Mock the ws module globally
vi.mock('ws', () => ({
  WebSocket: MockWebSocket
}));

// Mock fs module for screenshot tests
vi.mock('fs', () => ({
  writeFileSync: vi.fn()
}));

// Mock sharp module for screenshot scaling tests
vi.mock('sharp', () => {
  const mockSharp = (buffer: Buffer) => {
    const instance = {
      metadata: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
      resize: vi.fn().mockReturnValue({
        toBuffer: vi.fn().mockResolvedValue(buffer)
      }),
      toBuffer: vi.fn().mockResolvedValue(buffer)
    };
    return instance;
  };
  return { default: mockSharp };
});

// Install mock fetch globally BEFORE any imports
// This ensures daemon checks fail and tests use direct WebSocket path
globalThis.fetch = createMockFetch() as any;
