/**
 * Lay out authored HTML in an offscreen browser, then report what it measured.
 *
 * Run *by Electron*: `electron scripts/compile-slides.cjs <job.json>`.
 * The job names the pages to measure, where to write the result, and the walk
 * itself — `src/shared/htmlMeasure.ts` serialises the very function the
 * editor's own renderer runs, so the two browsers cannot drift apart. This
 * file is only the process around it: open a window, evaluate, write, exit.
 *
 * Pages are measured in one window, one after another. Starting Electron costs
 * about as much as measuring a whole deck, so a caller with fifty pages should
 * not pay it fifty times.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));

app.disableHardwareAcceleration();
// A helper, not an app: keep it out of the macOS Dock, where every run would
// otherwise put an Electron icon for as long as it lasts.
if (process.platform === 'darwin') app.dock.hide();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: job.canvas.w,
    height: job.canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  try {
    const results = [];
    for (const page of job.pages) {
      await win.loadURL(pathToFileURL(page).href);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      results.push(await win.webContents.executeJavaScript(job.script));
    }
    writeFileSync(job.outPath, JSON.stringify({ results }), 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, pages: results.length }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});
