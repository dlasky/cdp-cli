/**
 * Mock WebSocket for testing CDP interactions
 */

import { EventEmitter } from 'events';

export class MockWebSocket extends EventEmitter {
  public readyState = 1; // OPEN
  public sentMessages: any[] = [];
  private autoRespond: boolean;

  constructor(url: string, options?: { autoRespond?: boolean }) {
    super();
    this.autoRespond = options?.autoRespond ?? true;

    // Simulate async connection
    setTimeout(() => {
      this.emit('open');
    }, 0);
  }

  send(data: string): void {
    const message = JSON.parse(data);
    this.sentMessages.push(message);

    // Auto-respond to commands if enabled
    if (this.autoRespond) {
      this.autoRespondToCommand(message);
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  off(event: string, handler: (...args: any[]) => void): this {
    return super.off(event, handler);
  }

  /**
   * Simulate receiving a CDP message
   */
  simulateMessage(message: any): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  /**
   * Simulate CDP error
   */
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  /**
   * Auto-respond to common CDP commands
   */
  private autoRespondToCommand(message: any): void {
    const { id, method } = message;

    // Delay response to simulate network
    setTimeout(() => {
      let result: any = {};

      switch (method) {
        case 'DOM.enable':
        case 'Runtime.enable':
        case 'Network.enable':
        case 'Page.enable':
        case 'Accessibility.enable':
          result = {};
          break;

        case 'DOM.getDocument':
          result = {
            root: {
              nodeId: 1,
              nodeName: 'HTML'
            }
          };
          break;

        case 'DOM.querySelectorAll':
          result = {
            nodeIds: [42]
          };
          break;

        case 'DOM.querySelector':
          result = {
            nodeId: 42
          };
          break;

        case 'DOM.resolveNode':
          result = {
            object: {
              objectId: 'object-42'
            }
          };
          break;

        case 'DOM.describeNode':
          result = {
            node: {
              nodeName: 'BUTTON',
              attributes: ['id', 'submit', 'class', 'btn primary']
            }
          };
          break;

        case 'DOM.getBoxModel':
          result = {
            model: {
              content: [100, 100, 200, 100, 200, 200, 100, 200]
            }
          };
          break;

        case 'Runtime.callFunctionOn':
          result = {
            result: {
              value: {
                tagName: 'button',
                id: 'submit',
                classes: ['btn', 'primary'],
                text: 'Submit',
                rect: {
                  x: 100,
                  y: 100,
                  width: 100,
                  height: 100
                }
              }
            }
          };
          break;

        case 'DOM.focus':
        case 'DOM.setAttributeValue':
          result = {};
          break;

        case 'Page.navigate':
          result = {
            frameId: 'frame123'
          };
          break;

        case 'Page.reload':
          result = {};
          break;

        case 'Page.getNavigationHistory':
          result = {
            currentIndex: 1,
            entries: [
              { id: 1, url: 'https://example.com' },
              { id: 2, url: 'https://example.com/page1' },
              { id: 3, url: 'https://example.com/page2' }
            ]
          };
          break;

        case 'Page.navigateToHistoryEntry':
          result = {};
          break;

        case 'Page.captureScreenshot':
          result = {
            data: 'base64encodeddata=='
          };
          break;

        case 'Page.getLayoutMetrics':
          result = {
            layoutViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720
            },
            cssContentSize: {
              width: 1280,
              height: 720
            }
          };
          break;

        case 'Runtime.evaluate':
          // Return viewport dimensions if the expression asks for them
          if (message.params?.expression?.includes('innerWidth')) {
            result = {
              result: {
                type: 'string',
                value: JSON.stringify({ width: 1280, height: 720 })
              }
            };
          } else if (message.params?.expression?.includes('clickableSelector')) {
            // Actionable elements snapshot (ax format)
            result = {
              result: {
                type: 'object',
                value: [
                  {
                    role: 'button',
                    selector: '#submit',
                    label: 'Submit',
                    action: 'click'
                  },
                  {
                    role: 'input:text',
                    selector: 'input[name="email"]',
                    label: 'Email',
                    name: 'email',
                    action: 'fill'
                  }
                ]
              }
            };
          } else {
            result = {
              result: {
                type: 'string',
                value: 'test result'
              }
            };
          }
          break;

        case 'Input.dispatchMouseEvent':
        case 'Input.dispatchKeyEvent':
          result = {};
          break;

        case 'Accessibility.getFullAXTree':
          result = {
            nodes: []
          };
          break;

        case 'Browser.getWindowForTarget':
          result = {
            windowId: 101,
            bounds: {
              windowState: 'normal',
              width: 1280,
              height: 720
            }
          };
          break;

        case 'Browser.setWindowBounds':
          result = {};
          break;

        case 'Page.handleJavaScriptDialog':
          result = {};
          break;

        case 'Target.createTarget':
          result = {
            targetId: 'new-page-123'
          };
          break;

        case 'Runtime.getProperties':
          result = {
            result: [
              {
                name: 'key',
                enumerable: true,
                value: { type: 'string', value: 'expanded-value' }
              }
            ]
          };
          break;

        case 'Runtime.releaseObject':
          result = {};
          break;

        default:
          result = {};
      }

      this.simulateMessage({ id, result });
    }, 10);
  }

  /**
   * Get all messages sent to a specific method
   */
  getMessagesByMethod(method: string): any[] {
    return this.sentMessages.filter(m => m.method === method);
  }

  /**
   * Get the last message sent
   */
  getLastMessage(): any {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  /**
   * Clear sent messages
   */
  clearMessages(): void {
    this.sentMessages = [];
  }
}
