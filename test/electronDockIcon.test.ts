import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every Electron process the tests and the CLI start is a helper nobody
 * switches to: hidden windows, gone in seconds. macOS still gives each one a
 * Dock icon for as long as it runs, so a test run — dozens of launches, a few
 * at a time — keeps "Electron" icons popping in and out of the developer's
 * Dock. Each entry point hands its icon back as it starts; this is what keeps
 * a new helper from forgetting to.
 */

const HIDE_DOCK = "if (process.platform === 'darwin') app.dock.hide();";
const scripts = join(process.cwd(), 'scripts');
/** Scripts Electron runs as its main process: the ones that take `app`. */
const electronMains = readdirSync(scripts)
  .filter((name) => name.endsWith('.cjs'))
  .filter((name) => /const \{[^}]*\bapp\b[^}]*\} = require\('electron'\)/
    .test(readFileSync(join(scripts, name), 'utf8')));

describe('Electron helpers stay out of the macOS Dock', () => {
  it('finds the helper scripts', () => {
    expect(electronMains).toEqual(expect.arrayContaining(['capture-slides.cjs', 'eval-browser.cjs']));
  });

  it.each(electronMains)('%s hides its Dock icon', (name) => {
    expect(readFileSync(join(scripts, name), 'utf8')).toContain(HIDE_DOCK);
  });

  it('the desktop app hides it when a test launches it headless', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const start = main.indexOf("if (process.env['DECKWERK_HEADLESS_TEST'] === '1') {");
    expect(start).toBeGreaterThan(-1);
    expect(main.slice(start, main.indexOf('\n}\n', start))).toContain(HIDE_DOCK);
  });
});
