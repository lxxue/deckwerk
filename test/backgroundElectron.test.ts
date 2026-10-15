import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backgroundElectronBinary } from '../src/cli/backgroundElectron.js';

/**
 * Helpers start from a clone of npm's Electron.app that declares LSUIElement,
 * so macOS never gives them a Dock icon — not even for the instant before
 * `app.dock.hide()` could run. The probe here never calls `dock.hide()`: what
 * it reports is the bundle's own doing.
 */

const electron = (() => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : '';
  } catch {
    return '';
  }
})();

const PROBE = `
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<p>painted</p>');
  const text = await win.webContents.executeJavaScript('document.body.textContent');
  process.stdout.write(JSON.stringify({ dockVisible: app.dock.isVisible(), text }));
  app.exit(0);
});
`;

/** The bundle's LSUIElement as plutil reads it, or null when it has none. */
function lsuiElement(binary: string): string | null {
  const plist = join(binary, '../../Info.plist');
  try {
    return execFileSync('plutil', ['-extract', 'LSUIElement', 'raw', plist], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

describe('backgroundElectronBinary', () => {
  it('passes through any binary that is not npm\'s Electron', async () => {
    const packaged = '/Applications/DeckWerk.app/Contents/MacOS/DeckWerk';
    expect(await backgroundElectronBinary(packaged)).toBe(packaged);
  });
});

describe.runIf(process.platform === 'darwin' && electron)('Electron helpers start without a Dock icon', { timeout: 60_000 }, () => {
  let work: string;
  let savedTmp: string | undefined;

  beforeAll(async () => {
    // A temp directory of its own, so the clone is made cold here rather
    // than found from an earlier run.
    work = await mkdtemp(join(tmpdir(), 'background-electron-test-'));
    savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = work;
  });

  afterAll(async () => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    await rm(work, { recursive: true, force: true });
  });

  it('spawns a clone whose bundle declares LSUIElement', async () => {
    const binary = await backgroundElectronBinary(electron);
    expect(binary).not.toBe(electron);
    expect(binary.startsWith(join(work, 'deckwerk-background-electron'))).toBe(true);
    // The control: npm's bundle does not declare it, which is the whole bug.
    expect(lsuiElement(electron)).toBeNull();
    expect(lsuiElement(binary)).toBe('true');
  });

  it('starts Electron as an agent app that still renders', async () => {
    const probe = join(work, 'probe.cjs');
    await writeFile(probe, PROBE);
    const binary = await backgroundElectronBinary(electron);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, [probe], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || `probe exited ${code}`)));
    });
    expect(JSON.parse(output)).toEqual({ dockVisible: false, text: 'painted' });
  });

  it('shares one clone between launches, concurrent ones included', async () => {
    const first = await backgroundElectronBinary(electron);
    const parallel = await Promise.all(Array.from({ length: 4 }, () => backgroundElectronBinary(electron)));
    expect(new Set([first, ...parallel])).toEqual(new Set([first]));
    const root = join(work, 'deckwerk-background-electron');
    expect((await readdir(root)).filter((name) => !name.startsWith('.'))).toHaveLength(1);
  });

  it('sweeps earlier days\' clones and abandoned staging, but not recent ones', async () => {
    const root = join(work, 'deckwerk-background-electron');
    const current = (await readdir(root)).find((name) => !name.startsWith('.'))!;
    const ageDays = async (name: string, days: number) => {
      await mkdir(join(root, name));
      const then = new Date(Date.now() - days * 24 * 60 * 60_000);
      await utimes(join(root, name), then, then);
    };
    await ageDays('stale-clone', 3);
    await ageDays('yesterdays-clone', 1);
    await ageDays('.abandoned-staging', 1);
    // Sweeping happens when a clone is made: make today's again.
    await rm(join(root, current), { recursive: true, force: true });
    await backgroundElectronBinary(electron);
    expect((await readdir(root)).sort()).toEqual([current, 'yesterdays-clone'].sort());
  });
});
