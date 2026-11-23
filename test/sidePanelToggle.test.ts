// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSidePanelToggle,
  onSidePanelShownChange,
  setSidePanelShown,
  sidePanelShown,
} from '../src/renderer/editor/sidePanelToggle.js';

/**
 * The side panel's show/hide preference and its toolbar button: shown until
 * someone hides it, remembered per machine, followed across windows, and a
 * button whose press never takes focus from a text box being edited. The
 * shells' part (what hiding does to the tabs, the canvas and Chat's count)
 * runs in the real app: test/sidePanelToggleBrowser.test.ts.
 */

const KEY = 'deckwerk.editor.side-panel';

beforeEach(() => {
  localStorage.clear();
  setSidePanelShown(true);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('side panel preference', () => {
  it('is shown until someone hides it', async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import('../src/renderer/editor/sidePanelToggle.js');
    expect(fresh.sidePanelShown()).toBe(true);
  });

  it('remembers a hidden panel across a reload', async () => {
    setSidePanelShown(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    vi.resetModules();
    expect((await import('../src/renderer/editor/sidePanelToggle.js')).sidePanelShown()).toBe(false);
    setSidePanelShown(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    vi.resetModules();
    expect((await import('../src/renderer/editor/sidePanelToggle.js')).sidePanelShown()).toBe(true);
  });

  it('tells its listeners once per change, and follows another window', () => {
    const heard: boolean[] = [];
    const stop = onSidePanelShownChange(() => heard.push(sidePanelShown()));
    setSidePanelShown(false);
    setSidePanelShown(false);
    setSidePanelShown(true);
    expect(heard).toEqual([false, true]);

    // Another editor window hid it: only the storage event says so.
    localStorage.setItem(KEY, '0');
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(sidePanelShown()).toBe(false);
    window.dispatchEvent(new StorageEvent('storage', { key: 'deckwerk.editor.rulers' }));
    expect(heard).toEqual([false, true, false]);
    stop();
    setSidePanelShown(true);
    expect(heard).toEqual([false, true, false]);
  });

  it('still hides for this page when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.resetModules();
    const fresh = await import('../src/renderer/editor/sidePanelToggle.js');
    expect(fresh.sidePanelShown()).toBe(true);
    fresh.setSidePanelShown(false);
    expect(fresh.sidePanelShown()).toBe(false);
  });
});

describe('side panel toolbar button', () => {
  it('names the panel it controls and says what a click will do', () => {
    const button = createSidePanelToggle();
    document.body.append(button);
    expect(button.getAttribute('aria-label')).toBe('Side panel');
    expect(button.getAttribute('aria-controls')).toBe('side');
    expect(button.classList.contains('bar-icon-button')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Hide side panel');

    button.click();
    expect(sidePanelShown()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Show side panel');

    button.click();
    expect(sidePanelShown()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('follows a change made elsewhere', () => {
    const button = createSidePanelToggle();
    setSidePanelShown(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Show side panel');
  });

  it('keeps focus where it was when pressed', () => {
    const button = createSidePanelToggle();
    const field = document.createElement('div');
    field.contentEditable = 'true';
    document.body.append(field, button);
    field.focus();
    for (const type of ['pointerdown', 'mousedown']) {
      const press = new MouseEvent(type, { bubbles: true, cancelable: true });
      button.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
  });
});
