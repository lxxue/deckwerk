/**
 * Hide and show the side panel (Props, Design, Build, and Chat in the browser)
 * from the right end of the toolbar, so the slide can have the whole width
 * while it is looked at rather than edited.
 *
 * Whether the panel shows is a per-machine view preference in localStorage,
 * like the rulers (rulers.ts): it carries across sessions and decks, follows a
 * choice made in another window, and never touches deck.json. Each shell does
 * the hiding itself (`syncPanels` in editor/main.ts and collab/main.ts): a
 * hidden panel takes its open tab with it, exactly as switching away from that
 * tab would, so what only works while on screen -- the inspector's redraws,
 * the build order, chat's read marker -- waits until the panel is back.
 */

const STORAGE_KEY = 'deckwerk.editor.side-panel';

/* --- the preference --------------------------------------------------------- */

const listeners = new Set<() => void>();
let shown = readShown();
let followingStorage = false;

function readShown(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function sidePanelShown(): boolean {
  return shown;
}

export function setSidePanelShown(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

export function toggleSidePanel(): void {
  setSidePanelShown(!shown);
}

export function onSidePanelShownChange(listener: () => void): () => void {
  listeners.add(listener);
  // A choice made in another window of the app (a second editor) lands here.
  if (!followingStorage) {
    followingStorage = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      const next = readShown();
      if (next === shown) return;
      shown = next;
      for (const notify of listeners) notify();
    });
  }
  return () => listeners.delete(listener);
}

/* --- the toolbar button ----------------------------------------------------- */

/** A window with its right-hand pane filled in while the panel shows. */
const SIDE_PANEL_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path class="side-panel-toggle-pane" d="M10 3h2.5A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5H10z" fill="currentColor" opacity=".5"/>' +
  '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M10 3.5v9" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

/**
 * The toolbar's side-panel button, for the right end of the toolbar, above
 * the panel it hides. Pressed while the panel shows, like the object list's
 * toggle; the tooltip says what a click will do.
 */
export function createSidePanelToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bar-icon-button side-panel-toggle';
  button.innerHTML = SIDE_PANEL_ICON;
  button.setAttribute('aria-label', 'Side panel');
  button.setAttribute('aria-controls', 'side');
  // Hiding the panel changes the view, not what is being edited: the press
  // must not take focus from a text box mid-edit (or end the edit with it).
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => toggleSidePanel());
  const sync = (): void => {
    button.setAttribute('aria-pressed', String(shown));
    button.title = shown ? 'Hide side panel' : 'Show side panel';
  };
  sync();
  onSidePanelShownChange(sync);
  return button;
}
