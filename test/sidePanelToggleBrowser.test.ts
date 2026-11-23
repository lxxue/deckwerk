import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cdp, electronBinary, eventually } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';

/**
 * The toolbar's side-panel toggle (sidePanelToggle.ts) in the REAL desktop
 * app and the browser editor, with real input: it sits at the toolbar's right
 * end as tall as Present, hides Props / Design / Build (and Chat) with the
 * resize divider and gives the canvas their width, keeps a text edit going
 * when pressed mid-edit, takes the Build tab's badges with it, survives a
 * reload, and in the browser carries Chat's unread count while the Chat tab
 * is hidden with the panel.
 */
const TEXT = 'side-panel-text';
const TOGGLE = '#toolbar .side-panel-toggle';

interface Box { left: number; right: number; width: number; height: number }

interface Layout {
  sideShown: boolean;
  sideWidth: number;
  /** null where the shell has no resize divider (the browser editor). */
  dividerShown: boolean | null;
  canvas: Box;
  stage: Box;
  pressed: string | null;
  title: string;
  lastInToolbar: boolean;
  toggle: Box;
  present: Box;
  windowWidth: number;
}

const readLayout = (cdp: Cdp) => cdp.evaluate<Layout>(`(() => {
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const side = document.getElementById('side');
  const divider = document.querySelector('.panel-resize-side');
  const toggle = document.querySelector('${TOGGLE}');
  return {
    sideShown: getComputedStyle(side).display !== 'none',
    sideWidth: side.getBoundingClientRect().width,
    dividerShown: divider ? getComputedStyle(divider).display !== 'none' : null,
    canvas: box(document.getElementById('canvas')),
    stage: box(document.querySelector('#canvas .stage')),
    pressed: toggle.getAttribute('aria-pressed'),
    title: toggle.title,
    lastInToolbar: document.querySelector('#toolbar .bar-right').lastElementChild === toggle,
    toggle: box(toggle),
    present: box(document.querySelector('#toolbar .toolbar-split-main.primary')),
    windowWidth: window.innerWidth,
  };
})()`);

/** The slide sits centred in the canvas, as the canvas fits it. */
const centred = (layout: Layout): boolean =>
  Math.abs((layout.stage.left + layout.stage.right) / 2 - (layout.canvas.left + layout.canvas.right) / 2) <= 2;

/** Start a test with the panel on screen, whatever the one before it left. */
async function ensureShown(cdp: Cdp): Promise<void> {
  if ((await readLayout(cdp)).sideShown) return;
  await cdp.click(TOGGLE, 'the side-panel toggle');
  await eventually(() => readLayout(cdp), 'the side panel did not come back',
    (layout) => layout.sideShown && centred(layout));
}

/** Hide the panel from the toolbar and check what the canvas got for it. */
async function hideAndMeasure(cdp: Cdp): Promise<{ before: Layout; after: Layout }> {
  const before = await readLayout(cdp);
  expect(before.sideShown).toBe(true);
  expect(before.pressed).toBe('true');
  expect(before.title).toBe('Hide side panel');
  await cdp.click(TOGGLE, 'the side-panel toggle');
  // The canvas fits the slide again from its ResizeObserver, a frame after
  // the column changed: wait for the slide to be centred in the new width.
  const after = await eventually(() => readLayout(cdp), 'the toggle did not hide the side panel and refit the slide',
    (layout) => !layout.sideShown && layout.canvas.width > before.canvas.width + 1 && centred(layout));
  expect(after.pressed).toBe('false');
  expect(after.title).toBe('Show side panel');
  // The canvas took the panel's whole column.
  expect(Math.abs(after.canvas.width - (before.canvas.width + before.sideWidth))).toBeLessThanOrEqual(2);
  expect(after.stage.width).toBeGreaterThanOrEqual(before.stage.width - 1);
  // A slide limited by the canvas's width grows into what the panel left.
  const widthLimited = before.canvas.width / before.canvas.height < 16 / 9;
  if (widthLimited) expect(after.stage.width).toBeGreaterThan(before.stage.width + 1);
  return { before, after };
}

async function showAgain(cdp: Cdp, expected: Layout): Promise<void> {
  await cdp.click(TOGGLE, 'the side-panel toggle');
  const back = await eventually(() => readLayout(cdp), 'the toggle did not show the side panel again',
    (layout) => layout.sideShown && Math.abs(layout.canvas.width - expected.canvas.width) <= 1
      && Math.abs(layout.stage.width - expected.stage.width) <= 1 && centred(layout));
  expect(back.pressed).toBe('true');
  expect(Math.abs(back.sideWidth - expected.sideWidth)).toBeLessThanOrEqual(1);
  expect(back.dividerShown).toBe(expected.dividerShown);
}

/** The toggle ends the toolbar, as tall as Present, inset as the toolbar insets everything. */
function expectPlacedAtToolbarEnd(layout: Layout): void {
  expect(layout.lastInToolbar).toBe(true);
  expect(Math.abs(layout.toggle.height - layout.present.height)).toBeLessThanOrEqual(1);
  expect(Math.round(layout.windowWidth - layout.toggle.right)).toBe(12);
  expect(layout.toggle.left).toBeGreaterThan(layout.present.right);
}

let desktop: DesktopEditor | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  desktop = await launchDesktopEditor(TEXT, '<p>Side panel</p>');
}, 180_000);

afterAll(async () => {
  await desktop?.close();
  desktop = null;
});

describe.skipIf(!electronBinary)('side-panel toggle in the desktop app', () => {
  it('hides the panel and its divider and gives the canvas their width', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await ensureShown(cdp);
    const { before, after } = await hideAndMeasure(cdp);
    expectPlacedAtToolbarEnd(before);
    expect(before.dividerShown).toBe(true);
    expect(after.dividerShown).toBe(false);
    expect(await cdp.evaluate(`localStorage.getItem('deckwerk.editor.side-panel')`)).toBe('0');
    // The open tab went with it: the inspector stops redrawing while hidden.
    expect(await cdp.evaluate<boolean>(`document.getElementById('inspector').hidden`)).toBe(true);
    await showAgain(cdp, before);
    expect(await cdp.evaluate<boolean>(`document.getElementById('inspector').hidden`)).toBe(false);
    expect(await cdp.evaluate(`localStorage.getItem('deckwerk.editor.side-panel')`)).toBe('1');
  });

  it('keeps a text edit going when pressed mid-edit', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await ensureShown(cdp);
    const content = `#canvas [data-element-id="${TEXT}"] .text-content`;
    const editing = () => cdp.evaluate<boolean>(`(() => {
      const box = document.querySelector('#canvas [data-element-id="${TEXT}"]');
      return Boolean(box?.querySelector('.editing, [contenteditable="true"]') || box?.classList.contains('editing'))
        && Boolean(document.activeElement && box.contains(document.activeElement));
    })()`);
    await cdp.doubleClick(content, 'the text box');
    await eventually(editing, 'the text box did not enter editing');

    const before = await readLayout(cdp);
    await cdp.click(TOGGLE, 'the side-panel toggle');
    await eventually(async () => !(await readLayout(cdp)).sideShown, 'the toggle did not hide the side panel mid-edit');
    expect(await editing()).toBe(true);
    // Typing still reaches the box: the press took no focus.
    await cdp.typeKeys('Q');
    await eventually(async () => cdp.evaluate<string>(`document.querySelector('${content}').textContent`),
      'typing after the toggle did not reach the text box', (text) => text.includes('Q'));

    await showAgain(cdp, before);
    expect(await editing()).toBe(true);
    await cdp.key('Escape', 27);
  });

  it('remembers a hidden panel across a reload', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await ensureShown(cdp);
    const { before } = await hideAndMeasure(cdp);
    await cdp.evaluate('location.reload()');
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('${TOGGLE}')
      && document.querySelector('#canvas [data-element-id="${TEXT}"]'))`), 'the editor did not come back');
    const reloaded = await eventually(() => readLayout(cdp), 'the reloaded editor did not settle',
      (layout) => Math.abs(layout.canvas.width - (before.canvas.width + before.sideWidth)) <= 2);
    expect(reloaded.sideShown).toBe(false);
    expect(reloaded.dividerShown).toBe(false);
    expect(reloaded.pressed).toBe('false');
    await showAgain(cdp, before);
  });
});

describe.skipIf(!electronBinary)('side-panel toggle in the browser editor', () => {
  let web: WebEditorSession | null = null;

  beforeAll(async () => {
    if (!electronBinary) return;
    const deck = parseDeck({
      ...emptyDeck('Side panel on the web'),
      slides: [{
        id: 'slide-a',
        elements: [{
          id: TEXT, type: 'text', x: 300, y: 200, w: 800, h: 160, class: ['role-body'], html: 'Builds in',
        }],
        timeline: [{
          id: 'build-1',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: TEXT, value: null },
        }],
      }],
    });
    web = await launchWebEditor([{ id: 'side-panel', deck }], { userName: 'Ada', tmpPrefix: 'side-panel-' });
  }, 180_000);

  afterAll(async () => {
    await web?.close();
    web = null;
  });

  it('hides Props, Design, Build and Chat, and gives the canvas their width', { timeout: 60_000 }, async () => {
    const { cdp } = web!;
    await ensureShown(cdp);
    const { before } = await hideAndMeasure(cdp);
    expectPlacedAtToolbarEnd(before);
    expect(before.dividerShown).toBeNull();
    await showAgain(cdp, before);
  });

  it("takes the Build tab's badges with it and brings them back", { timeout: 60_000 }, async () => {
    const { cdp } = web!;
    await ensureShown(cdp);
    const badges = () => cdp.evaluate<number>(`document.querySelectorAll('#canvas .build-badge').length`);
    await cdp.click('#side-tabs button[data-panel="timeline"]', 'Build tab');
    await eventually(badges, 'the Build tab did not number the build on the slide', (count) => count > 0);
    const before = await readLayout(cdp);
    await cdp.click(TOGGLE, 'the side-panel toggle');
    await eventually(badges, 'hiding the panel left the build badges on the slide', (count) => count === 0);
    expect(await cdp.evaluate<boolean>(`document.getElementById('timeline').hidden`)).toBe(true);
    await showAgain(cdp, before);
    await eventually(badges, 'showing the panel did not bring the build badges back', (count) => count > 0);
    expect(await cdp.evaluate<boolean>(
      `document.querySelector('#side-tabs button[data-panel="timeline"]').classList.contains('active')`,
    )).toBe(true);
    await cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  });

  it("carries Chat's unread count while the Chat tab is hidden with the panel", { timeout: 60_000 }, async () => {
    const { cdp, origin, deckId } = web!;
    await ensureShown(cdp);
    const toggleBadge = () => cdp.evaluate<{ text: string | null; description: string | null }>(`(() => {
      const toggle = document.querySelector('${TOGGLE}');
      return {
        text: toggle.querySelector('.chat-tab-badge')?.textContent ?? null,
        description: toggle.getAttribute('aria-description'),
      };
    })()`);
    const tabBadge = () => cdp.evaluate<string | null>(
      `document.querySelector('#side-tabs button[data-panel="chat"] .chat-tab-badge')?.textContent ?? null`);
    await cdp.click('#side-tabs button[data-panel="chat"]', 'Chat tab');
    const before = await readLayout(cdp);
    await cdp.click(TOGGLE, 'the side-panel toggle');
    await eventually(async () => !(await readLayout(cdp)).sideShown, 'the toggle did not hide the side panel');
    expect(await cdp.evaluate<boolean>(`document.getElementById('chat').hidden`)).toBe(true);
    expect((await toggleBadge()).text).toBeNull();

    const posted = await fetch(`${origin}/api/chat?deck=${encodeURIComponent(deckId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Slide 1 is ready for a look' }),
    });
    expect(posted.status).toBe(200);
    // Hidden, Chat cannot have been read: the count waits on the toggle.
    const unread = await eventually(toggleBadge, 'the unread message did not show on the toggle',
      (badge) => badge.text === '1');
    expect(unread.description).toBe('1 unread in Chat');

    await showAgain(cdp, before);
    // Back on screen on the Chat tab, the message is read: no count anywhere.
    await eventually(async () => ({ toggle: (await toggleBadge()).text, tab: await tabBadge() }),
      'showing the Chat tab again did not read the message',
      (badges) => badges.toggle === null && badges.tab === null);
    expect(await cdp.evaluate<boolean>(`document.getElementById('chat').hidden`)).toBe(false);
    await cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  });
});

describe.skipIf(electronBinary)('side-panel toggle (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
