/**
 * Debugging commands: console, snapshot, eval, screenshot
 */

import { CDPContext, ConsoleMessage } from '../context.js';
import { outputLine, outputError, outputSuccess, outputRaw } from '../output.js';
import { writeFileSync } from 'fs';
import { extname } from 'node:path';
import sharp from 'sharp';
import { createExecSession, createExecSessionByPageRef } from '../daemon/exec.js';

/**
 * Recursively expand an object/array via CDP Runtime.getProperties
 */
async function expandValue(
  context: CDPContext,
  ws: any,
  arg: any,
  depth: number = 0,
  maxDepth: number = 3
): Promise<any> {
  // Primitive values - return directly
  if (arg.value !== undefined) return arg.value;

  // Don't recurse too deep
  if (depth >= maxDepth) {
    return arg.description || 'Object';
  }

  // Objects/arrays with objectId - fetch and expand properties
  if (arg.objectId) {
    try {
      const props = await context.sendCommand(ws, 'Runtime.getProperties', {
        objectId: arg.objectId,
        ownProperties: true
      });

      if (props.result && props.result.length > 0) {
        const isArray = arg.subtype === 'array' || arg.className === 'Array';
        const enumerable = props.result.filter((p: any) => p.enumerable !== false);

        if (isArray) {
          const arrayEntries = enumerable
            .filter((p: any) => /^\d+$/.test(p.name))
            .sort((a: any, b: any) => parseInt(a.name) - parseInt(b.name));

          return await Promise.all(
            arrayEntries.map(async (p: any) => {
              if (p.value) {
                return await expandValue(context, ws, p.value, depth + 1, maxDepth);
              }
              return null;
            })
          );
        } else {
          const obj: any = {};
          for (const p of enumerable) {
            if (p.value) {
              obj[p.name] = await expandValue(context, ws, p.value, depth + 1, maxDepth);
            }
          }
          return obj;
        }
      }
    } catch {
      return arg.description || 'Object';
    }
  }

  // Fallback
  return arg.description || null;
}

/**
 * List console messages
 */
export async function listConsole(
  context: CDPContext,
  options: { type?: string; page: string; duration?: number; inspect?: boolean }
): Promise<void> {
  let ws;
  const duration = options.duration ?? 0;
  try {
    // Get page to monitor
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    // Connect and enable Runtime domain
    ws = await context.connect(page);

    const wsRef = ws;
    context.setupConsoleCollection(ws, (message: ConsoleMessage) => {
      if (options.type && message.type !== options.type) {
        return;
      }

      if (options.inspect && message.args && message.args.length > 0) {
        // Wrap async expansion to avoid unhandled rejections
        void (async () => {
          try {
            const expandedArgs = await Promise.all(
              message.args!.map(async (arg: any) => {
                return await expandValue(context, wsRef, arg, 0, 3);
              })
            );
            message.text = expandedArgs.map(a => JSON.stringify(a)).join(' ');
          } catch {
            // Fall through with original text on expansion failure
          }
          outputLine({
            type: message.type,
            timestamp: message.timestamp,
            text: message.text,
            source: message.source,
            ...(message.line !== undefined && { line: message.line }),
            ...(message.url && { url: message.url })
          });
        })();
        return;
      }

      outputLine({
        type: message.type,
        timestamp: message.timestamp,
        text: message.text,
        source: message.source,
        ...(message.line !== undefined && { line: message.line }),
        ...(message.url && { url: message.url })
      });
    });
    await context.sendCommand(ws, 'Runtime.enable');

    if (duration > 0) {
      await new Promise(resolve => setTimeout(resolve, duration * 1000));
    } else {
      await new Promise<void>((resolve) => {
        function cleanup(): void {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
        }

        function onSigint(): void {
          process.exitCode = 130;
          cleanup();
          resolve();
        }

        function onSigterm(): void {
          process.exitCode = 143;
          cleanup();
          resolve();
        }

        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
      });
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'LIST_CONSOLE_FAILED'
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Take a snapshot of the page (DOM or accessibility tree)
 */
export async function snapshot(
  context: CDPContext,
  options: { format?: string; page: string }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  try {
    // Use daemon if available (optimized path), otherwise findPage + direct WebSocket
    session = await createExecSessionByPageRef(context, options.page);
    await session.assertNoDevTools();
    await session.assertNoDialog();

    const format = options.format || 'ax';

    if (format === 'text') {
      // Simple text snapshot
      await session.exec('Runtime.enable');
      const result = await session.exec('Runtime.evaluate', {
        expression: 'document.body.innerText',
        returnByValue: true
      });

      outputRaw(result.result?.value || '');
    } else if (format === 'ax') {
      // Simplified actionable elements snapshot for integration testing
      await session.exec('Runtime.enable');
      const result = await session.exec('Runtime.evaluate', {
        expression: `
(() => {
  const results = [];
  const seen = new Set();

  // Selectors for clickable elements
  const clickableSelector = [
    'button',
    '[role="button"]',
    'a[href]',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="reset"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'select',
    'label',
    'summary',
    '[onclick]',
    '[onmousedown]',
    '[ng-click]',
    '[data-action]',
    'li.item',
    '[class*="-btn"]'
  ].join(',');

  // Selectors for fillable elements
  const fillableSelector = [
    'input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
    'textarea',
    '[contenteditable="true"]'
  ].join(',');

  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);

    // Try data-testid or name
    const testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';

    // Build a path, anchored on nearest ID
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 4) {
      let selector = current.tagName.toLowerCase();

      // If we hit an ID, anchor there and stop
      if (current.id && current !== el) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(selector);
      current = parent;
    }
    return parts.join(' > ');
  }

  function formatElement(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const rect = el.getBoundingClientRect();

    // Skip invisible elements
    if (rect.width === 0 && rect.height === 0) return null;

    // Skip duplicates
    if (seen.has(el)) return null;
    seen.add(el);

    const info = {
      role: role || tag + (type ? ':' + type : ''),
      selector: getSelector(el)
    };

    // Get label/name
    const rawText = (el.innerText || '').trim();
    const text = rawText.replace(/[\\r\\n]+/g, ' ').replace(/\\s{2,}/g, ' ').slice(0, 80);
    const title = el.getAttribute('title');
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const value = el.value;
    const name = el.getAttribute('name');

    // Try aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    let labelledByText = '';
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) labelledByText = (labelEl.innerText || '').trim().replace(/[\\r\\n]+/g, ' ').replace(/\\s{2,}/g, ' ').slice(0, 60);
    }

    // For icon buttons, check child elements for title/aria-label
    let iconLabel = '';
    if (!text && (tag === 'button' || tag === 'a')) {
      const icon = el.querySelector('[title], [aria-label], i[class], svg[class]');
      if (icon) {
        iconLabel = icon.getAttribute('title') || icon.getAttribute('aria-label') || '';
        if (!iconLabel && icon.className) {
          // Try to extract icon name from class (e.g., 'fa-edit' -> 'edit')
          const match = icon.className.match(/(?:fa|icon|bi|mdi)-([a-z-]+)/i);
          if (match) iconLabel = match[1].replace(/-/g, ' ');
        }
      }
    }

    if (ariaLabel) info.label = ariaLabel;
    else if (labelledByText) info.label = labelledByText;
    else if (title) info.label = title;
    else if (iconLabel) info.label = iconLabel;
    else if (text && text.length < 60) info.label = text;
    else if (placeholder) info.label = placeholder;

    if (name) info.name = name;
    if (value && tag === 'select') info.value = value;
    if (value && (tag === 'input' || tag === 'textarea') && type !== 'password') {
      info.value = value.slice(0, 40);
    }

    // Checkbox/radio state
    if (el.checked !== undefined) info.checked = el.checked;

    // Select options
    if (tag === 'select' && el.options) {
      info.options = Array.from(el.options).slice(0, 5).map(o => o.text.trim().slice(0, 30));
      if (el.options.length > 5) info.options.push('...');
    }

    return info;
  }

  // Find clickable elements
  document.querySelectorAll(clickableSelector).forEach(el => {
    const info = formatElement(el);
    if (info) {
      info.action = 'click';
      results.push(info);
    }
  });

  // Find fillable elements
  document.querySelectorAll(fillableSelector).forEach(el => {
    const info = formatElement(el);
    if (info) {
      info.action = 'fill';
      results.push(info);
    }
  });

  return results;
})()
        `,
        returnByValue: true
      });

      const elements = result.result?.value || [];

      // Format as simple lines
      const lines = elements.map((el: any) => {
        let line = `[${el.role}]`;
        if (el.label) line += ` "${el.label}"`;
        if (el.name) line += ` name=${el.name}`;
        if (el.value) line += ` value="${el.value}"`;
        if (el.checked !== undefined) line += el.checked ? ' ✓' : ' ○';
        if (el.options) line += ` options=[${el.options.map((o: string) => `"${o}"`).join(',')}]`;
        line += ` → ${el.selector}`;
        return line;
      });

      outputRaw(lines.join('\n'));
    } else {
      throw new Error(`Unknown snapshot format: ${format}`);
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'SNAPSHOT_FAILED',
      { format: options.format }
    );
    process.exit(1);
  } finally {
    session?.close();
  }
}

/**
 * Evaluate JavaScript expression
 */
export async function evaluate(
  context: CDPContext,
  expression: string,
  options: { page: string }
): Promise<void> {
  let session: Awaited<ReturnType<typeof createExecSessionByPageRef>> | undefined;
  try {
    // Use daemon if available (optimized path), otherwise findPage + direct WebSocket
    session = await createExecSessionByPageRef(context, options.page);
    await session.assertNoDevTools();
    await session.assertNoDialog();

    await session.exec('Runtime.enable');
    const result = await session.exec('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.exceptionDetails) {
      outputError(
        result.exceptionDetails.text,
        'EVAL_EXCEPTION',
        result.exceptionDetails
      );
      process.exit(1);
    }

    outputLine({
      success: true,
      value: result.result?.value,
      type: result.result?.type
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'EVAL_FAILED',
      { expression }
    );
    process.exit(1);
  } finally {
    session?.close();
  }
}

/**
 * Take a screenshot
 */
export async function screenshot(
  context: CDPContext,
  options: { output?: string; format?: string; page: string; quality?: number; scale?: number }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);

    // Check for blocking dialog before attempting screenshot
    await context.assertNoDialog(ws);

    const validFormats = ['jpeg', 'png', 'webp'];
    const detectedFormat = (() => {
      const explicitFormat = options.format?.toLowerCase();
      if (explicitFormat) {
        return explicitFormat;
      }

      if (!options.output) {
        return undefined;
      }

      const extension = extname(options.output).toLowerCase();
      if (!extension) {
        return undefined;
      }

      const normalizedExtension = extension.slice(1);
      if (normalizedExtension === 'jpg') {
        return 'jpeg';
      }

      if (validFormats.includes(normalizedExtension)) {
        return normalizedExtension;
      }

      return undefined;
    })();

    const format = detectedFormat ?? 'jpeg';

    if (!validFormats.includes(format)) {
      throw new Error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    }

    const quality = options.quality || 90;
    const scale = options.scale ?? 1;

    if (scale <= 0 || scale > 1) {
      throw new Error(`Invalid scale: ${scale}. Must be between 0 (exclusive) and 1 (inclusive).`);
    }

    const captureParams: Record<string, any> = {
      format,
      quality: format === 'jpeg' ? quality : undefined
    };

    const result = await context.sendCommand(ws, 'Page.captureScreenshot', captureParams);

    let buffer: Buffer = Buffer.from(result.data, 'base64');

    // Resize with sharp if scale !== 1 (avoids CDP viewport side effects)
    if (scale !== 1) {
      const image = sharp(buffer);
      const metadata = await image.metadata();
      if (metadata.width && metadata.height) {
        const newWidth = Math.round(metadata.width * scale);
        buffer = Buffer.from(await image.resize(newWidth).toBuffer());
      }
    }

    if (options.output) {
      writeFileSync(options.output, buffer);

      outputSuccess('Screenshot saved', {
        file: options.output,
        format,
        size: buffer.length
      });
    } else {
      outputLine({
        success: true,
        format,
        data: buffer.toString('base64')
      });
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'SCREENSHOT_FAILED',
      { output: options.output }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Check for and optionally handle JavaScript dialogs (alert/confirm/prompt)
 */
export async function dialog(
  context: CDPContext,
  options: { page: string; dismiss?: boolean; accept?: boolean; promptText?: string }
): Promise<void> {
  let ws;
  try {
    const page = await context.findPage(options.page);
    ws = await context.connect(page);

    const dialogInfo = await context.checkForDialog(ws);

    if (!dialogInfo) {
      outputLine({
        success: true,
        dialog: null,
        message: 'No dialog present'
      });
      return;
    }

    // If action specified, handle the dialog
    if (options.dismiss || options.accept) {
      const action = options.accept ? 'accept' : 'dismiss';
      await context.handleDialog(ws, options.accept ?? false, options.promptText);

      outputSuccess(`Dialog ${action}ed`, {
        type: dialogInfo.type,
        message: dialogInfo.message,
        action,
        promptText: options.promptText
      });
    } else {
      // Just report dialog info
      outputLine({
        success: true,
        dialog: {
          type: dialogInfo.type,
          message: dialogInfo.message,
          url: dialogInfo.url,
          defaultPrompt: dialogInfo.defaultPrompt
        },
        hint: "Use --dismiss or --accept to handle the dialog"
      });
    }
  } catch (error) {
    outputError(
      (error as Error).message,
      'DIALOG_FAILED',
      {}
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
