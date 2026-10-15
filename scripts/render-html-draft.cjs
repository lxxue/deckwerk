/** Offscreen PNG renderer used when the collaboration server runs under Node. */
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
app.disableHardwareAcceleration();
// A helper, not an app: keep it out of the macOS Dock, where every run would
// otherwise put an Electron icon for as long as it lasts.
if (process.platform === 'darwin') app.dock.hide();

app.whenReady().then(async () => {
  try {
    writeFileSync(job.outPath, await render());
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error));
    app.exit(1);
  }
});

async function render() {
  const win = new BrowserWindow({
    width: job.canvas.w, height: job.canvas.h, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(pathToFileURL(job.pagePath).href);
    await settle(win);
    const count = await win.webContents.executeJavaScript(
      'document.querySelectorAll("section.slide, .slide").length');
    if (count === 0) throw new Error('No slides found in HTML draft');
    if (job.slideIndex !== null) {
      if (job.slideIndex < 0 || job.slideIndex >= count) {
        throw new Error(`No draft slide ${job.slideIndex + 1}`);
      }
      return (await capture(win, job.slideIndex)).toPNG();
    }

    const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));
    const thumbWidth = 420;
    const thumbHeight = Math.round((thumbWidth * job.canvas.h) / job.canvas.w);
    const gap = 12;
    const labelHeight = 28;
    const rows = Math.ceil(count / columns);
    const sheetWidth = columns * thumbWidth + (columns + 1) * gap;
    const sheetHeight = rows * (thumbHeight + labelHeight) + (rows + 1) * gap;
    const cells = [];
    for (let index = 0; index < count; index += 1) {
      const image = (await capture(win, index)).resize({ width: thumbWidth, height: thumbHeight });
      cells.push(`<figure><img src="${image.toDataURL()}" width="${thumbWidth}" height="${thumbHeight}"><figcaption>${index + 1}</figcaption></figure>`);
    }
    const sheetPath = join(dirname(job.pagePath), 'contact-sheet.html');
    writeFileSync(sheetPath, `<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;background:#17181c;color:#fff}
      body{display:grid;grid-template-columns:repeat(${columns},${thumbWidth}px);gap:${gap}px;padding:${gap}px}
      figure{margin:0}img{display:block;outline:1px solid #555}figcaption{height:${labelHeight}px;font:600 16px/${labelHeight}px -apple-system,sans-serif}
    </style>${cells.join('')}`);
    win.setContentSize(sheetWidth, sheetHeight);
    await win.loadURL(pathToFileURL(sheetPath).href);
    await settle(win);
    return (await win.webContents.capturePage({ x: 0, y: 0, width: sheetWidth, height: sheetHeight })).toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function capture(win, index) {
  await win.webContents.executeJavaScript(`(() => {
    const slides = [...document.querySelectorAll('section.slide, .slide')];
    slides.forEach((slide, i) => { slide.style.display = i === ${index} ? '' : 'none'; });
    document.documentElement.style.cssText += ';margin:0;width:${job.canvas.w}px;height:${job.canvas.h}px;overflow:hidden';
    document.body.style.cssText += ';margin:0;width:${job.canvas.w}px;height:${job.canvas.h}px;overflow:hidden';
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })()`);
  return win.webContents.capturePage({ x: 0, y: 0, width: job.canvas.w, height: job.canvas.h });
}

async function settle(win) {
  await win.webContents.executeJavaScript(`Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    ...[...document.images].map((image) => image.decode().catch(() => null))
  ]).then(() => {
    const failed = [...document.images].filter((image) => !image.complete || image.naturalWidth === 0);
    if (failed.length) throw new Error('Raster assets failed to load: ' + failed.map((image) => image.currentSrc || image.src).join(', '));
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })`);
}
