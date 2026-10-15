import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The Electron to spawn for a helper nobody switches to: the compile, capture
 * and page check behind `slide-agent`, and the hidden browser and app the
 * tests drive.
 *
 * macOS gives an app bundle its Dock icon the moment the process checks in
 * with LaunchServices, before Electron has run a line of JavaScript — unless
 * the bundle's Info.plist declares `LSUIElement`. The helpers hand the icon
 * back with `app.dock.hide()` as they start, but that still flashed
 * "Electron" in the Dock on every agent save and every test launch. npm's
 * Electron.app does not declare it and node_modules is not ours to edit, so
 * helpers run from a clone of it that does: an agent app from its first
 * instant, which is the activation policy `dock.hide()` switches to anyway.
 *
 * The clone is a clonefile(2) copy under the OS temp directory: milliseconds
 * to make and next to no disk, since it shares every block with npm's copy.
 * npm's bundle is ad-hoc linker-signed with its Info.plist unbound, so editing
 * the plist leaves the signature exactly as valid as the original's. Any
 * other binary — another platform, a packaged app whose signature does bind
 * its Info.plist — and any clone that cannot be made gets the binary it was
 * given, and the helpers' own `dock.hide()` is the fallback.
 */
export function backgroundElectronBinary(binary: string): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve(binary);
  const bundle = NPM_ELECTRON.exec(binary)?.[1];
  if (!bundle) return Promise.resolve(binary);
  // Concurrent launches in one process share a clone in flight. The result is
  // not memoised past that: a long-running editor or collab server must move
  // on to the next day's clone, not keep a path the sweep will remove.
  let clone = inFlight.get(bundle);
  if (!clone) {
    clone = cloneWithoutDockIcon(bundle)
      .catch((error: unknown) => {
        if (process.env.SLIDE_AGENT_DEBUG === '1') {
          process.stderr.write(`Starting Electron with its Dock icon: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        return binary;
      })
      .finally(() => inFlight.delete(bundle));
    inFlight.set(bundle, clone);
  }
  return clone;
}

const NPM_ELECTRON = /^(.*\/node_modules\/electron\/dist\/Electron\.app)\/Contents\/MacOS\/Electron$/;
const EXECUTABLE = 'Contents/MacOS/Electron';
const FRAMEWORK = 'Contents/Frameworks/Electron Framework.framework/Electron Framework';
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const inFlight = new Map<string, Promise<string>>();
const run = promisify(execFile);

async function cloneWithoutDockIcon(bundle: string): Promise<string> {
  const executable = await stat(join(bundle, EXECUTABLE));
  // Keyed by the Electron it came from, so a reinstall or an upgrade gets a
  // clone of its own, and by the day: a clone is retired long before the OS
  // temp sweep could find it unused and leave it half-deleted.
  const key = createHash('sha256')
    .update(`${bundle}\0${executable.ino}:${executable.size}:${executable.mtimeMs}\0${Math.floor(Date.now() / DAY_MS)}`)
    .digest('hex')
    .slice(0, 16);
  const root = join(tmpdir(), 'deckwerk-background-electron');
  const entry = join(root, key);
  const binary = join(entry, 'Electron.app', EXECUTABLE);
  if (await isComplete(entry)) return binary;

  await mkdir(root, { recursive: true });
  // Built aside and renamed into place whole, so a parallel launch never
  // spawns a half-copied bundle.
  const staging = join(root, `.${key}-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(staging);
    const staged = join(staging, 'Electron.app');
    await run('cp', ['-cR', bundle, staged]).catch(async () => {
      // Not APFS, or another volume: no clonefile, so a real copy, once a day.
      await rm(staged, { recursive: true, force: true });
      await run('cp', ['-R', bundle, staged]);
    });
    await run('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', join(staged, 'Contents/Info.plist')]);
    await rename(staging, entry).catch(async (error: unknown) => {
      // Another launch finished the same clone first; theirs is as good.
      if (!await isComplete(entry)) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await sweep(root, key);
  return binary;
}

async function isComplete(entry: string): Promise<boolean> {
  try {
    await access(join(entry, 'Electron.app', EXECUTABLE));
    await access(join(entry, 'Electron.app', FRAMEWORK));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove earlier days' clones, and staging left by a launch that died. A
 * clone of an Electron since deleted holds its blocks, all 231 MB of them,
 * until it goes. A clone is launched from only on the day it was made, so at
 * two days old the last helper it started has had a whole day to finish.
 */
async function sweep(root: string, keep: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name === keep) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > (name.startsWith('.') ? HOUR_MS : 2 * DAY_MS)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
