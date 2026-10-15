import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every Electron process the tests and the CLI start is a helper nobody
 * switches to: hidden windows, gone in seconds. macOS still gives each one a
 * Dock icon for as long as it runs, so a test run — dozens of launches, a few
 * at a time — keeps "Electron" icons popping in and out of the developer's
 * Dock. Two layers keep it out: every launch starts from a clone of Electron
 * whose bundle declares LSUIElement (src/cli/backgroundElectron.ts), so the
 * icon never appears, and each entry point still hands its icon back as it
 * starts, for when no clone can be made. This keeps a new launcher or helper
 * from forgetting either one.
 */

const HIDE_DOCK = "if (process.platform === 'darwin') app.dock.hide();";
/** A spawn of the Electron binary as resolved, rather than of its background clone. */
const SPAWNS_ELECTRON_DIRECTLY = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*electron\w*(?:\(\))?\s*,/;
const sources = ['src', 'scripts', 'test']
  .flatMap((dir) => readdirSync(join(process.cwd(), dir), { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name)))
  .filter((path) => /\.(?:[cm]?ts|[cm]js)$/.test(path) && !path.includes('node_modules'));
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

  it('every launch spawns the clone that never shows an icon', () => {
    const launchers = sources.filter((path) =>
      readFileSync(join(process.cwd(), path), 'utf8').includes('backgroundElectronBinary('));
    expect(launchers).toEqual(expect.arrayContaining([
      join('src', 'cli', 'compileHtml.ts'),
      join('src', 'cli', 'renderSlides.ts'),
      join('test', 'support', 'browserSession.ts'),
      join('test', 'support', 'desktopApp.ts'),
    ]));
    expect(sources.filter((path) =>
      SPAWNS_ELECTRON_DIRECTLY.test(readFileSync(join(process.cwd(), path), 'utf8')))).toEqual([]);
  });

  it('the desktop app hides it when a test launches it headless', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const start = main.indexOf("if (process.env['DECKWERK_HEADLESS_TEST'] === '1') {");
    expect(start).toBeGreaterThan(-1);
    expect(main.slice(start, main.indexOf('\n}\n', start))).toContain(HIDE_DOCK);
  });
});
