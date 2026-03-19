/**
 * Input automation commands: click, fill, press-key
 */

import { CDPContext, type Page } from '../context.js';
import { outputError, outputSuccess } from '../output.js';

type TextMatchMode = 'exact' | 'contains' | 'regex';

interface ClickTargetInput {
  selector?: string;
  text?: string;
  match?: TextMatchMode;
  caseSensitive?: boolean;
  nth?: number;
  within?: string;
}

interface DragTargetInput {
  selector?: string;
  text?: string;
  match?: TextMatchMode;
  caseSensitive?: boolean;
  nth?: number;
  within?: string;
  x?: number;
  y?: number;
}

interface DragOptions {
  page: string;
  touch?: boolean;
  longpress?: number;
  steps?: number;
  duration?: number;
}

interface ElementMetadata {
  tagName: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface ElementMatch {
  nodeId: number;
  metadata: ElementMetadata;
}

class ClickError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Helper function to find element by selector
 */
async function findElement(
  context: CDPContext,
  ws: any,
  selector: string
): Promise<{ nodeId: number }> {
  await context.sendCommand(ws, 'DOM.enable');
  const doc = await context.sendCommand(ws, 'DOM.getDocument');
  const node = await context.sendCommand(ws, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector
  });

  if (!node.nodeId) {
    throw new Error(`Element not found: ${selector}`);
  }

  return { nodeId: node.nodeId };
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  const sliceLength = Math.max(maxLength - 3, 0);
  const prefix = text.slice(0, sliceLength);
  return `${prefix}...`;
}

function normalizeMetadata(raw: any): ElementMetadata {
  const classes = Array.isArray(raw?.classes)
    ? raw.classes.filter((cls: unknown): cls is string => typeof cls === 'string')
    : [];
  const rectSource = raw?.rect ?? {};
  const toNumber = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const tagName =
    typeof raw?.tagName === 'string' ? raw.tagName.toLowerCase() : '';

  return {
    tagName,
    id: typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : null,
    classes,
    text: typeof raw?.text === 'string' ? raw.text : '',
    rect: {
      x: toNumber(rectSource.x),
      y: toNumber(rectSource.y),
      width: toNumber(rectSource.width),
      height: toNumber(rectSource.height)
    }
  };
}

function summarizeMatches(matches: ElementMatch[]): string[] {
  return matches.map((match, index) => {
    const { tagName, id, classes, text } = match.metadata;
    let line = `${index + 1}. [${tagName}]`;
    if (text) line += ` "${truncate(text, 50)}"`;
    // Build selector from metadata
    let selector = tagName;
    if (id) selector += `#${id}`;
    if (classes.length) selector += `.${classes.join('.')}`;
    line += ` → ${selector}`;
    return line;
  });
}

function roundRect(rect: ElementMetadata['rect']): ElementMetadata['rect'] {
  const roundValue = (value: number): number =>
    Number.isFinite(value) ? Math.round(value) : 0;

  return {
    x: roundValue(rect.x),
    y: roundValue(rect.y),
    width: roundValue(rect.width),
    height: roundValue(rect.height)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeReleaseObject(
  context: CDPContext,
  ws: any,
  objectId?: string
): Promise<void> {
  if (!objectId) {
    return;
  }
  try {
    await context.sendCommand(ws, 'Runtime.releaseObject', { objectId });
  } catch {
    // Ignore release errors – the target may already be gone.
  }
}

async function getElementMetadataFromObjectId(
  context: CDPContext,
  ws: any,
  objectId: string
): Promise<ElementMetadata> {
  try {
    const callResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `
        function() {
          const rect = this.getBoundingClientRect();
          const classList = this.classList ? Array.from(this.classList) : [];
          const textContent = (this.innerText || '').trim();
          return {
            tagName: (this.tagName || '').toLowerCase(),
            id: this.id || null,
            classes: classList,
            text: textContent,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          };
        }
      `,
      returnByValue: true
    });
    return normalizeMetadata(callResult.result?.value);
  } finally {
    await safeReleaseObject(context, ws, objectId);
  }
}

async function getElementMetadataForNode(
  context: CDPContext,
  ws: any,
  nodeId: number
): Promise<ElementMetadata> {
  const resolved = await context.sendCommand(ws, 'DOM.resolveNode', { nodeId });
  const objectId = resolved.object?.objectId;

  if (!objectId) {
    const described = await context.sendCommand(ws, 'DOM.describeNode', {
      nodeId,
      depth: 0,
      pierce: false
    });
    const attributes = Array.isArray(described.node?.attributes)
      ? described.node.attributes
      : [];
    const attrMap: Record<string, string> = {};
    for (let i = 0; i < attributes.length; i += 2) {
      attrMap[attributes[i]] = attributes[i + 1];
    }

    return normalizeMetadata({
      tagName: typeof described.node?.nodeName === 'string'
        ? described.node.nodeName.toLowerCase()
        : '',
      id: attrMap.id ?? null,
      classes: (attrMap.class || '')
        .split(/\s+/)
        .filter(Boolean),
      text: '',
      rect: {
        x: 0,
        y: 0,
        width: 0,
        height: 0
      }
    });
  }

  return getElementMetadataFromObjectId(context, ws, objectId);
}

async function resolveBySelector(
  context: CDPContext,
  ws: any,
  selector: string,
  within?: string
): Promise<ElementMatch[]> {
  const doc = await context.sendCommand(ws, 'DOM.getDocument');

  let rootNodeId = doc.root.nodeId;
  if (within) {
    const containerResult = await context.sendCommand(ws, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: within
    });
    if (!containerResult.nodeId) {
      throw new Error(`Container not found: ${within}`);
    }
    rootNodeId = containerResult.nodeId;
  }

  const result = await context.sendCommand(ws, 'DOM.querySelectorAll', {
    nodeId: rootNodeId,
    selector
  });

  const nodeIds: number[] = Array.isArray(result.nodeIds)
    ? result.nodeIds
    : typeof (result as { nodeId?: number }).nodeId === 'number'
      ? [ (result as { nodeId: number }).nodeId ]
      : [];

  const matches: ElementMatch[] = [];

  for (const nodeId of nodeIds) {
    const metadata = await getElementMetadataForNode(context, ws, nodeId);
    matches.push({ nodeId, metadata });
  }

  return matches;
}

function buildTextSearchExpression(
  text: string,
  match: TextMatchMode,
  caseSensitive: boolean,
  within?: string
): string {
  const serializedText = JSON.stringify(text);
  const serializedMatch = JSON.stringify(match);
  const caseFlag = caseSensitive ? 'true' : 'false';
  const serializedWithin = within ? JSON.stringify(within) : 'null';

  return `
(() => {
  const pattern = ${serializedText};
  const mode = ${serializedMatch};
  const caseSensitive = ${caseFlag};
  const withinSelector = ${serializedWithin};
  let normalizedPattern = pattern;
  const results = [];
  const seen = new Set();
  let regex = null;
  const actionableSelector = 'button,[role="button"],li.item,[class*="-btn"],input[type="submit"],input[type="button"],input[type="reset"],input[type="checkbox"],input[type="radio"],a[href],textarea,select,label,summary';

  if (mode === 'regex') {
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (error) {
      return { error: error.message };
    }
  } else if (!caseSensitive && typeof pattern === 'string') {
    normalizedPattern = pattern.toLowerCase();
  }

  let root = document.body || document.documentElement;
  if (withinSelector) {
    const container = document.querySelector(withinSelector);
    if (!container) {
      return { error: 'Container not found: ' + withinSelector };
    }
    root = container;
  }
  if (!root) {
    return { matches: [] };
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!el) continue;

    const textContent = (el.innerText || '').trim();
    if (!textContent) continue;

    let isMatch = false;
    if (mode === 'regex') {
      if (!regex) continue;
      isMatch = regex.test(textContent);
    } else {
      const candidate = caseSensitive ? textContent : textContent.toLowerCase();
      if (mode === 'contains') {
        isMatch = candidate.includes(normalizedPattern);
      } else {
        isMatch = candidate === normalizedPattern;
      }
    }

    if (isMatch) {
      const actionable = el.closest(actionableSelector);
      const directMatch = el.matches && el.matches(actionableSelector);
      let target = actionable || (directMatch ? el : null);

      // Fallback: check for inline handlers or button-like classes
      if (!target) {
        const hasInlineHandler = (node) => {
          return node.hasAttribute && (
            node.hasAttribute('onclick') ||
            node.hasAttribute('onmousedown') ||
            node.hasAttribute('onmouseup') ||
            node.hasAttribute('ontouchstart') ||
            node.hasAttribute('onpointerdown') ||
            node.hasAttribute('ng-click') ||
            node.hasAttribute('data-action')
          );
        };

        const hasButtonClass = (node) => {
          if (!node.classList) return false;
          for (const cls of node.classList) {
            if (cls.endsWith('-btn') || cls.includes('button')) return true;
          }
          return false;
        };

        // Check element and ancestors for clickability
        let candidate = el;
        while (candidate && candidate !== document.body) {
          if (hasInlineHandler(candidate) || hasButtonClass(candidate)) {
            target = candidate;
            break;
          }
          candidate = candidate.parentElement;
        }
      }

      if (!target || seen.has(target)) continue;

      const rect = target.getBoundingClientRect();
      const hasLayout = rect && (rect.width !== 0 || rect.height !== 0);
      if (!hasLayout) continue;

      seen.add(target);
      results.push(target);
    }
  }

  return { matches: results };
})()
  `.trim();
}

async function resolveByText(
  context: CDPContext,
  ws: any,
  target: ClickTargetInput
): Promise<ElementMatch[]> {
  const text = target.text ?? '';
  const matchMode: TextMatchMode = target.match ?? 'exact';
  const caseSensitive = target.caseSensitive ?? false;
  const within = target.within;

  const expression = buildTextSearchExpression(text, matchMode, caseSensitive, within);
  const evaluation = await context.sendCommand(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: false
  });

  if (evaluation.exceptionDetails) {
    const message =
      evaluation.exceptionDetails.text ||
      evaluation.exceptionDetails.exception?.description ||
      'Runtime evaluation failed';
    throw new ClickError(message, 'CLICK_TEXT_SEARCH_ERROR', {
      text,
      match: matchMode,
      caseSensitive
    });
  }

  const evalResult = evaluation.result;
  const containerId = evalResult?.objectId;

  if (!containerId) {
    const errorMessage =
      typeof evalResult?.value === 'object' && evalResult?.value !== null
        ? (evalResult.value as Record<string, unknown>).error
        : undefined;

    if (typeof errorMessage === 'string') {
      throw new ClickError(
        `Invalid text pattern: ${errorMessage}`,
        'CLICK_TEXT_SEARCH_ERROR',
        { text, match: matchMode, caseSensitive }
      );
    }

    return [];
  }

  let matchesObjectId: string | undefined;
  let searchError: string | undefined;

  try {
    const containerProps = await context.sendCommand(
      ws,
      'Runtime.getProperties',
      {
        objectId: containerId,
        ownProperties: true
      }
    );

    for (const descriptor of containerProps.result ?? []) {
      if (descriptor.name === 'error' && descriptor.value) {
        const value = descriptor.value.value;
        if (typeof value === 'string') {
          searchError = value;
        }
      }
      if (descriptor.name === 'matches' && descriptor.value?.objectId) {
        matchesObjectId = descriptor.value.objectId;
      }
    }
  } finally {
    await safeReleaseObject(context, ws, containerId);
  }

  if (typeof searchError === 'string' && searchError.length > 0) {
    throw new ClickError(
      `Invalid text pattern: ${searchError}`,
      'CLICK_TEXT_SEARCH_ERROR',
      { text, match: matchMode, caseSensitive }
    );
  }

  if (!matchesObjectId) {
    return [];
  }

  const matches: ElementMatch[] = [];

  try {
    const matchesProps = await context.sendCommand(
      ws,
      'Runtime.getProperties',
      {
        objectId: matchesObjectId,
        ownProperties: true
      }
    );

    for (const descriptor of matchesProps.result ?? []) {
      if (!/^\d+$/.test(descriptor.name)) {
        continue;
      }
      const remote = descriptor.value;
      if (!remote?.objectId) {
        continue;
      }

      const objId = remote.objectId;
      const requested = await context.sendCommand(ws, 'DOM.requestNode', {
        objectId: objId
      });

      if (typeof requested?.nodeId !== 'number') {
        await safeReleaseObject(context, ws, objId);
        continue;
      }

      const metadata = await getElementMetadataFromObjectId(
        context,
        ws,
        objId
      );

      matches.push({
        nodeId: requested.nodeId,
        metadata
      });
    }
  } finally {
    await safeReleaseObject(context, ws, matchesObjectId);
  }

  const unique: ElementMatch[] = [];
  const seenKeys = new Set<string>();

  for (const match of matches) {
    const { nodeId, metadata } = match;
    const rect = metadata.rect;
    const key = [
      nodeId,
      metadata.tagName,
      metadata.id ?? '',
      metadata.classes.join(' '),
      rect.x.toFixed(4),
      rect.y.toFixed(4),
      rect.width.toFixed(4),
      rect.height.toFixed(4),
      truncate(metadata.text, 32)
    ].join('|');

    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    unique.push(match);
  }

  return unique;
}

async function resolveClickCandidates(
  context: CDPContext,
  ws: any,
  target: ClickTargetInput
): Promise<ElementMatch[]> {
  if (target.selector) {
    return resolveBySelector(context, ws, target.selector, target.within);
  }

  if (target.text) {
    return resolveByText(context, ws, target);
  }

  return [];
}

/**
 * Click an element by CSS selector or text match
 */
export async function click(
  context: CDPContext,
  targetInput: ClickTargetInput | string,
  optionsInput: { page: string; double?: boolean; longpress?: number; touch?: boolean; userGesture?: boolean; wait?: number }
): Promise<void> {
  let ws;
  const target: ClickTargetInput =
    typeof targetInput === 'string'
      ? { selector: targetInput }
      : { ...targetInput };
  const options = { ...optionsInput };
  const longpressSeconds =
    typeof options.longpress === 'number' && Number.isFinite(options.longpress)
      ? Math.max(0, options.longpress)
      : 0;
  const longpressMs = longpressSeconds > 0 ? longpressSeconds * 1000 : 0;

  try {
    if (options.double && longpressSeconds > 0) {
      throw new ClickError(
        'Double click cannot be combined with long press',
        'CLICK_INVALID_OPTIONS',
        {
          double: options.double,
          longpress: longpressSeconds
        }
      );
    }

    if (options.touch && options.double) {
      throw new ClickError(
        'Touch mode does not support double tap (use two separate taps)',
        'CLICK_INVALID_OPTIONS',
        { touch: true, double: true }
      );
    }

    let page: Page;
    try {
      page = await context.findPage(options.page);
    } catch (primaryError) {
      const candidatePageId = target.selector;

      if (!candidatePageId) {
        throw primaryError;
      }

      try {
        const resolvedPage = await context.findPage(candidatePageId);
        const originalSelector = options.page;

        options.page = candidatePageId;
        target.selector = originalSelector;
        page = resolvedPage;
      } catch {
        throw primaryError;
      }
    }

    await context.assertNoDevTools(page.id);
    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    let matches: Awaited<ReturnType<typeof resolveClickCandidates>>;
    const waitTimeout = options.wait;

    if (waitTimeout && waitTimeout > 0) {
      // Poll for element to appear
      const startTime = Date.now();
      while (true) {
        matches = await resolveClickCandidates(context, ws, target);
        if (matches.length > 0) break;
        if (Date.now() - startTime >= waitTimeout) {
          throw new ClickError(
            target.selector
              ? `Timeout waiting for element: ${target.selector} (${waitTimeout}ms)`
              : `Timeout waiting for text "${target.text}" (${waitTimeout}ms)`,
            'CLICK_TIMEOUT',
            {
              selector: target.selector,
              text: target.text,
              match: target.selector ? undefined : target.match ?? 'exact',
              caseSensitive: target.caseSensitive ?? false,
              timeout: waitTimeout
            }
          );
        }
        await delay(100);
      }
    } else {
      matches = await resolveClickCandidates(context, ws, target);

      if (matches.length === 0) {
        throw new ClickError(
          target.selector
            ? `Element not found: ${target.selector}`
            : `No element matched text "${target.text}"`,
          'CLICK_NOT_FOUND',
          {
            selector: target.selector,
            text: target.text,
            match: target.selector ? undefined : target.match ?? 'exact',
            caseSensitive: target.caseSensitive ?? false
          }
        );
      }
    }

    let selectedIndex = 0;
    if (typeof target.nth === 'number') {
      if (target.nth < 1 || target.nth > matches.length) {
        throw new ClickError(
          `--nth ${target.nth} is out of range (1-${matches.length})`,
          'CLICK_NTH_OUT_OF_RANGE',
          {
            selector: target.selector,
            text: target.text,
            requestedNth: target.nth,
            match: target.selector ? undefined : target.match ?? 'exact',
            caseSensitive: target.caseSensitive ?? false,
            matches: summarizeMatches(matches)
          }
        );
      }
      selectedIndex = target.nth - 1;
    } else if (matches.length > 1) {
      throw new ClickError(
        'Multiple elements matched. Use --nth to choose one.',
        'CLICK_AMBIGUOUS',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          matches: summarizeMatches(matches)
        }
      );
    }

    const chosen = matches[selectedIndex];
    const rect = chosen.metadata.rect;

    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
      throw new ClickError(
        'Matched element has invalid layout coordinates',
        'CLICK_NO_LAYOUT',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          rect: roundRect(rect)
        }
      );
    }

    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;

    if (width === 0 && height === 0) {
      throw new ClickError(
        'Matched element has no visible area to click',
        'CLICK_NO_HITBOX',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false,
          rect: roundRect(rect)
        }
      );
    }

    const x = rect.x + width / 2;
    const y = rect.y + height / 2;
    const xRounded = Math.round(x);
    const yRounded = Math.round(y);
    const roundedRect = roundRect(rect);

    if (options.userGesture) {
      // Use Runtime.callFunctionOn with userGesture for activation-gated APIs
      // (WebXR, fullscreen, etc.) that Input.dispatchMouseEvent cannot trigger
      const resolved = await context.sendCommand(ws, 'DOM.resolveNode', { nodeId: chosen.nodeId });
      const objectId = resolved.object?.objectId;

      if (!objectId) {
        throw new ClickError(
          'Could not resolve element for user gesture click',
          'CLICK_RESOLVE_FAILED',
          { selector: target.selector, text: target.text }
        );
      }

      const clickCount = options.double ? 2 : 1;
      const clickResult = await context.sendCommand(ws, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { for (let i = 0; i < ${clickCount}; i++) { this.click(); } return { success: true, tagName: this.tagName, id: this.id || null }; }`,
        userGesture: true,
        returnByValue: true
      });

      await safeReleaseObject(context, ws, objectId);

      if (clickResult.result?.value?.error) {
        throw new ClickError(
          clickResult.result.value.error,
          'CLICK_USER_GESTURE_FAILED',
          { selector: target.selector, text: target.text }
        );
      }

      outputSuccess('Click performed with user gesture', {
        strategy: target.selector ? 'css' : 'text',
        selector: target.selector ?? null,
        text: target.text ?? null,
        userGesture: true,
        double: options.double || false,
        element: clickResult.result?.value
      });
    } else if (options.touch) {
      // Touch tap sequence
      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{
          id: 0,
          x,
          y,
          radiusX: 2.5,
          radiusY: 2.5,
          rotationAngle: 0,
          force: 1.0
        }]
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
    } else {
      // Mouse click sequence
      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y
      });

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1
      });

      if (options.double) {
        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 2
        });

        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 2
        });
      }
    }

    outputSuccess('Click performed', {
      strategy: target.selector ? 'css' : 'text',
      selector: target.selector ?? null,
      text: target.text ?? null,
      match: target.selector ? undefined : target.match ?? 'exact',
      caseSensitive: target.caseSensitive ?? false,
      within: target.within ?? null,
      index: selectedIndex + 1,
      totalMatches: matches.length,
      x: xRounded,
      y: yRounded,
      rect: roundedRect,
      double: options.double || false,
      longpress: longpressSeconds,
      touch: options.touch || false
    });
  } catch (error) {
    if (error instanceof ClickError) {
      outputError(error.message, error.code, error.details);
    } else {
      outputError(
        (error as Error).message,
        'CLICK_FAILED',
        {
          selector: target.selector,
          text: target.text,
          match: target.selector ? undefined : target.match ?? 'exact',
          caseSensitive: target.caseSensitive ?? false
        }
      );
    }
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Fill an input element
 */
export async function fill(
  context: CDPContext,
  selector: string,
  value: string,
  options: { page: string; nth?: number; within?: string }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');

    // Find all matching elements
    const matches = await resolveBySelector(context, ws, selector, options.within);

    if (matches.length === 0) {
      throw new Error(`Element not found: ${selector}`);
    }

    let selectedIndex = 0;
    if (typeof options.nth === 'number') {
      if (options.nth < 1 || options.nth > matches.length) {
        throw new Error(
          `--nth ${options.nth} is out of range (1-${matches.length})\n${summarizeMatches(matches).join('\n')}`
        );
      }
      selectedIndex = options.nth - 1;
    } else if (matches.length > 1) {
      throw new Error(
        `Multiple elements matched. Use --nth to choose one.\n${summarizeMatches(matches).join('\n')}`
      );
    }

    const { nodeId } = matches[selectedIndex];
    await context.sendCommand(ws, 'DOM.focus', { nodeId });

    // Clear existing value using DOM API (safe from code injection)
    await context.sendCommand(ws, 'DOM.setAttributeValue', {
      nodeId,
      name: 'value',
      value: ''
    });

    // Type the value
    for (const char of value) {
      await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char
      });

      await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char
      });
    }

    outputSuccess('Fill performed', {
      selector,
      value,
      within: options.within ?? null
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'FILL_FAILED',
      { selector, value }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

/**
 * Press a keyboard key
 */
export async function pressKey(
  context: CDPContext,
  key: string,
  options: { page: string }
): Promise<void> {
  let ws;
  try {
    // Get page
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    // Map common key names
    const keyMap: Record<string, string> = {
      'enter': 'Enter',
      'tab': 'Tab',
      'escape': 'Escape',
      'backspace': 'Backspace',
      'delete': 'Delete',
      'arrowup': 'ArrowUp',
      'arrowdown': 'ArrowDown',
      'arrowleft': 'ArrowLeft',
      'arrowright': 'ArrowRight',
      'space': ' '
    };

    const keyValue = keyMap[key.toLowerCase()] || key;

    await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyValue
    });

    await context.sendCommand(ws, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyValue
    });

    outputSuccess('Key pressed', {
      key: keyValue
    });
  } catch (error) {
    outputError(
      (error as Error).message,
      'PRESS_KEY_FAILED',
      { key }
    );
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}

class DragError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseCoordinates(input: string): { x: number; y: number } | null {
  const match = input.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const x = parseFloat(match[1]);
  const y = parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

async function resolveDragTarget(
  context: CDPContext,
  ws: any,
  target: DragTargetInput,
  label: string
): Promise<{ x: number; y: number; metadata?: ElementMetadata }> {
  // Direct coordinates
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: target.x, y: target.y };
  }

  // Resolve via element
  const clickTarget: ClickTargetInput = {
    selector: target.selector,
    text: target.text,
    match: target.match,
    caseSensitive: target.caseSensitive,
    nth: target.nth,
    within: target.within
  };

  const matches = await resolveClickCandidates(context, ws, clickTarget);

  if (matches.length === 0) {
    throw new DragError(
      target.selector
        ? `${label} element not found: ${target.selector}`
        : `${label}: no element matched text "${target.text}"`,
      'DRAG_NOT_FOUND',
      { label, selector: target.selector, text: target.text }
    );
  }

  let selectedIndex = 0;
  if (typeof target.nth === 'number') {
    if (target.nth < 1 || target.nth > matches.length) {
      throw new DragError(
        `${label}: --nth ${target.nth} is out of range (1-${matches.length})`,
        'DRAG_NTH_OUT_OF_RANGE',
        {
          label,
          selector: target.selector,
          text: target.text,
          requestedNth: target.nth,
          matches: summarizeMatches(matches)
        }
      );
    }
    selectedIndex = target.nth - 1;
  } else if (matches.length > 1) {
    throw new DragError(
      `${label}: multiple elements matched. Use --nth to choose one.`,
      'DRAG_AMBIGUOUS',
      {
        label,
        selector: target.selector,
        text: target.text,
        matches: summarizeMatches(matches)
      }
    );
  }

  const chosen = matches[selectedIndex];
  const rect = chosen.metadata.rect;
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;

  return {
    x: rect.x + width / 2,
    y: rect.y + height / 2,
    metadata: chosen.metadata
  };
}

/**
 * Drag from one element/position to another
 */
export async function drag(
  context: CDPContext,
  from: DragTargetInput,
  to: DragTargetInput,
  options: DragOptions
): Promise<void> {
  let ws;

  const steps = Math.max(1, options.steps ?? 10);
  const durationMs = Math.max(0, options.duration ?? 300);
  const longpressSeconds =
    typeof options.longpress === 'number' && Number.isFinite(options.longpress)
      ? Math.max(0, options.longpress)
      : 0;
  const longpressMs = longpressSeconds * 1000;
  const stepDelayMs = steps > 1 ? durationMs / (steps - 1) : 0;

  try {
    const page = await context.findPage(options.page);
    await context.assertNoDevTools(page.id);

    ws = await context.connect(page);
    await context.assertNoDialog(ws);

    await context.sendCommand(ws, 'DOM.enable');
    await context.sendCommand(ws, 'Runtime.enable');

    const fromPos = await resolveDragTarget(context, ws, from, 'Source');
    const toPos = await resolveDragTarget(context, ws, to, 'Destination');

    if (options.touch) {
      // Touch drag sequence
      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{
          id: 0,
          x: fromPos.x,
          y: fromPos.y,
          radiusX: 2.5,
          radiusY: 2.5,
          rotationAngle: 0,
          force: 1.0
        }]
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      // Move through intermediate points
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const currentX = fromPos.x + (toPos.x - fromPos.x) * progress;
        const currentY = fromPos.y + (toPos.y - fromPos.y) * progress;

        if (stepDelayMs > 0) {
          await delay(stepDelayMs);
        }

        await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{
            id: 0,
            x: currentX,
            y: currentY,
            radiusX: 2.5,
            radiusY: 2.5,
            rotationAngle: 0,
            force: 1.0
          }]
        });
      }

      await context.sendCommand(ws, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
    } else {
      // Mouse drag sequence
      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: fromPos.x,
        y: fromPos.y
      });

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: fromPos.x,
        y: fromPos.y,
        button: 'left',
        clickCount: 1
      });

      if (longpressMs > 0) {
        await delay(longpressMs);
      }

      // Move through intermediate points
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const currentX = fromPos.x + (toPos.x - fromPos.x) * progress;
        const currentY = fromPos.y + (toPos.y - fromPos.y) * progress;

        if (stepDelayMs > 0) {
          await delay(stepDelayMs);
        }

        await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: currentX,
          y: currentY,
          button: 'left'
        });
      }

      await context.sendCommand(ws, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: toPos.x,
        y: toPos.y,
        button: 'left',
        clickCount: 1
      });
    }

    outputSuccess('Drag performed', {
      mode: options.touch ? 'touch' : 'mouse',
      from: {
        x: Math.round(fromPos.x),
        y: Math.round(fromPos.y),
        selector: from.selector ?? null,
        text: from.text ?? null
      },
      to: {
        x: Math.round(toPos.x),
        y: Math.round(toPos.y),
        selector: to.selector ?? null,
        text: to.text ?? null
      },
      steps,
      duration: durationMs,
      longpress: longpressSeconds
    });
  } catch (error) {
    if (error instanceof DragError) {
      outputError(error.message, error.code, error.details);
    } else {
      outputError(
        (error as Error).message,
        'DRAG_FAILED',
        {
          from: { selector: from.selector, text: from.text },
          to: { selector: to.selector, text: to.text }
        }
      );
    }
    process.exit(1);
  } finally {
    if (ws) {
      ws.close();
    }
  }
}
