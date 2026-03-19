import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { outputSuccess, outputError } from '../output.js';

export type BrowserType = 'chrome' | 'helium';

interface BrowserConfig {
  path: string;
  name: string;
  dirPrefix: string;
}

const BROWSERS_MACOS: Record<BrowserType, BrowserConfig> = {
  chrome: {
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    name: 'Google Chrome',
    dirPrefix: 'cdp-cli-chrome',
  },
  helium: {
    path: '/Applications/Helium.app/Contents/MacOS/Helium',
    name: 'Helium',
    dirPrefix: 'cdp-cli-helium',
  },
};

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Launch a browser with remote debugging enabled
 */
export async function launchBrowser(options: { port: number; browser: BrowserType; stealth?: boolean }): Promise<void> {
  if (!isMacOS()) {
    outputError(
      'launch command is only supported on macOS',
      'UNSUPPORTED_PLATFORM',
      { platform: process.platform }
    );
    process.exit(1);
  }

  const config = BROWSERS_MACOS[options.browser];

  if (!existsSync(config.path)) {
    outputError(
      `${config.name} not found at expected location`,
      'BROWSER_NOT_FOUND',
      { path: config.path }
    );
    process.exit(1);
  }

  const { port } = options;

  const userDataDir = join(tmpdir(), `${config.dirPrefix}-${port}`);
  if (!existsSync(userDataDir)) {
    mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];

  if (options.stealth) {
    args.push('--disable-blink-features=AutomationControlled');

    if (options.browser === 'helium') {
      args.push(
        '--fingerprinting-client-rects-noise',
        '--fingerprinting-canvas-measuretext-noise',
        '--fingerprinting-canvas-image-data-noise'
      );
    }
  }

  try {
    const browserProcess = spawn(config.path, args, {
      detached: true,
      stdio: 'ignore'
    });

    // Wait for spawn confirmation before reporting success
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        browserProcess.removeListener('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        browserProcess.removeListener('spawn', onSpawn);
        reject(err);
      };

      browserProcess.once('spawn', onSpawn);
      browserProcess.once('error', onError);
    });

    browserProcess.unref();

    outputSuccess(`${config.name} launched`, {
      port,
      url: `http://localhost:${port}`,
      userDataDir,
      stealth: !!options.stealth
    });
  } catch (error) {
    outputError(
      `Failed to launch ${config.name}: ${(error as Error).message}`,
      'LAUNCH_FAILED'
    );
    process.exit(1);
  }
}
