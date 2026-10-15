/** Run by Electron: generate the real PDF, raster it, and compare every page with the Player. */
const { spawnSync } = require('node:child_process');
const { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { app, BrowserWindow, nativeImage, protocol, screen } = require('electron');
const { comparePixelBuffers } = require('./pixel-compare.cjs');

const jobPath = process.argv[2];
const job = JSON.parse(readFileSync(jobPath, 'utf8'));
const CHANNEL_TOLERANCE = job.channelTolerance ?? 32;
let activeDeckDir = '';

app.commandLine.appendSwitch('force-device-scale-factor', '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'deck', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
app.disableHardwareAcceleration();
// A helper, not an app: keep it out of the macOS Dock, where every run would
// otherwise put an Electron icon for as long as it lasts.
if (process.platform === 'darwin') app.dock.hide();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  protocol.handle('deck', (request) => serveAsset(request));
  const results = [];
  try {
    for (let deckIndex = 0; deckIndex < job.decks.length; deckIndex++) {
      const item = job.decks[deckIndex];
      activeDeckDir = item.deckDir;
      mkdirSync(item.outDir, { recursive: true });
      const pdfPath = join(item.outDir, 'export.pdf');
      const pageDir = join(item.outDir, 'pages');
      mkdirSync(pageDir, { recursive: true });

      const print = new BrowserWindow({ show: false, webPreferences: {
        offscreen: true,
        sandbox: false,
        preload: job.preload,
        additionalArguments: [`--pdf-fidelity-job=${jobPath}`, `--deck-index=${deckIndex}`],
      } });
      await print.loadFile(job.printPage, { query: {
        job: 'test', mode: item.mode, includeHidden: '0',
        ...(item.slideFilter ? { slide: item.slideFilter } : {}),
      } });
      await waitUntilReady(print);
      const pdf = await print.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      writeFileSync(pdfPath, pdf);
      print.destroy();

      const scale = screen.getPrimaryDisplay().scaleFactor;
      const raster = spawnSync(job.python, ['-c', RASTER_PDF, pdfPath, pageDir,
        String(Math.round(item.canvas.w * scale)), String(Math.round(item.canvas.h * scale))],
      { encoding: 'utf8' });
      if (raster.status !== 0) throw new Error(raster.stderr || 'Could not raster PDF');

      const player = new BrowserWindow({
        width: item.canvas.w, height: item.canvas.h, show: false, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false },
      });
      await player.loadFile(join(item.bundleDir, 'index.html'));
      for (let pageIndex = 0; pageIndex < item.pages.length; pageIndex++) {
        const expected = item.pages[pageIndex];
        await player.webContents.executeJavaScript(
          `window.__SLIDE_PLAYER__.goTo(${JSON.stringify({ slide: expected.slide, step: expected.step })})`,
        );
        await normalizePdfEmbedUrls(player);
        const videoDiagnostics = await settlePlayer(player, expected.videoTimes);
        const pdfEmbedDiagnostics = await inspectPdfEmbeds(player);
        const reference = pdfEmbedDiagnostics.length > 0
          ? await printPlayerReference(player, item, pageIndex, job.python)
          : await stableCapture(player);
        const actual = nativeImage.createFromPath(join(pageDir, `${pageIndex}.png`));
        const comparison = compare(reference, actual, expected.rasterToleranceBoxes, item.canvas);
        if (comparison.fraction > (job.reportAbove ?? 0)) {
          const name = `${expected.id}-step-${expected.step}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
          writeFileSync(join(item.outDir, `${name}-player.png`), reference.toPNG());
          writeFileSync(join(item.outDir, `${name}-pdf.png`), actual.toPNG());
          writeFileSync(join(item.outDir, `${name}-diff.png`), comparison.diff.toPNG());
        }
        results.push({ deck: item.name, id: expected.id, step: expected.step,
          fraction: comparison.fraction, differing: comparison.differing,
          total: comparison.total, size: comparison.size,
          videoDiagnostics, pdfEmbedDiagnostics });
      }
      player.destroy();
    }
    writeFileSync(job.outPath, JSON.stringify({ results }), 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, pages: results.length }));
    app.quit();
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
    app.quit();
  }
});

async function waitUntilReady(win) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`({
      ready: document.documentElement.dataset.ready || '',
      error: document.documentElement.dataset.error || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('PDF renderer timed out');
}

/**
 * Chromium's offscreen capture paints PDF <embed> plug-ins as black even
 * though the visible player and print pipeline render them correctly. For the
 * screenshot oracle only, rasterize the same first PDF page with the same
 * library used to rasterize the exported page, then replace each black plug-in
 * with that decoded image. This keeps geometry and visual-content comparison
 * meaningful without changing the product renderer.
 */
async function inspectPdfEmbeds(win) {
  return await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('embed[type="application/pdf"]')].map((embed, index) => {
      const rect = embed.getBoundingClientRect();
      return { index, src: embed.src, width: rect.width, height: rect.height };
    })
  `);
}

/** The exported bundle uses file: URLs, while the desktop Player and PDF
 * renderer use the deck asset protocol. Chromium's PDF plug-in does not print
 * file: embeds reliably from an offscreen window, so exercise the same URL
 * path as the actual desktop product before taking the reference. */
async function normalizePdfEmbedUrls(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const embeds = [...document.querySelectorAll('embed[type="application/pdf"]')];
    for (const embed of embeds) {
      const url = new URL(embed.src);
      const marker = '/assets/';
      const start = url.pathname.lastIndexOf(marker);
      if (start < 0) continue;
      const relative = decodeURIComponent(url.pathname.slice(start + 1));
      embed.src = 'deck://asset/' + relative.split('/').map(encodeURIComponent).join('/');
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })()`);
}

/**
 * Offscreen Chromium cannot screenshot its PDF plug-in: the plug-in surface is
 * returned as black. The print compositor does render it, so pages containing
 * PDF artwork use a one-page print of the already-positioned Player DOM as the
 * reference. All other pages continue to use a literal Player screenshot.
 */
async function printPlayerReference(win, item, pageIndex, python) {
  const styleId = '__pdf_fidelity_player_page__';
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById(${JSON.stringify(styleId)})?.remove();
    const style = document.createElement('style');
    style.id = ${JSON.stringify(styleId)};
    style.textContent = ${JSON.stringify(`
      @page { size: ${item.canvas.w}px ${item.canvas.h}px; margin: 0; }
      @media print {
        html, body { width: ${item.canvas.w}px !important; height: ${item.canvas.h}px !important;
          margin: 0 !important; overflow: hidden !important; }
      }
    `)};
    document.head.appendChild(style);
  })()`);
  await win.webContents.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
  );
  const pdfPath = join(item.outDir, `reference-${pageIndex}.pdf`);
  const pngPath = join(item.outDir, `reference-${pageIndex}.png`);
  const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  writeFileSync(pdfPath, pdf);
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const raster = spawnSync(python, ['-c', RASTER_PAGE, pdfPath, pngPath,
    String(Math.round(item.canvas.w * scale)), String(Math.round(item.canvas.h * scale))],
  { encoding: 'utf8' });
  if (raster.status !== 0) throw new Error(raster.stderr || 'Could not raster Player reference');
  return nativeImage.createFromPath(pngPath);
}

async function settlePlayer(win, videoTimes) {
  return await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images]
      .filter((image) => /\\.gif(?:$|[?#])/i.test(image.currentSrc || image.src))
      .map(async (image) => {
        try {
          const response = await fetch(image.currentSrc || image.src);
          if (!response.ok) return;
          const bitmap = await createImageBitmap(await response.blob());
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, bitmap.width);
          canvas.height = Math.max(1, bitmap.height);
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          image.src = canvas.toDataURL('image/png');
          await image.decode?.().catch(() => {});
        } catch {}
      }));
    await Promise.all([...document.images].map((image) => image.decode?.().catch(() => {})));
    const times = ${JSON.stringify([])}.concat(${JSON.stringify(videoTimes || [])});
    const eventOrTimeout = (target, event, timeout = 5000) => new Promise((done) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeEventListener(event, finish);
        done();
      };
      const timer = setTimeout(finish, timeout);
      target.addEventListener(event, finish, { once: true });
    });
    const paintedFrame = (video) => 'requestVideoFrameCallback' in video
      ? Promise.race([
          new Promise((done) => video.requestVideoFrameCallback(() => done())),
          new Promise((done) => setTimeout(done, 2000)),
        ])
      : new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await Promise.all([...document.querySelectorAll('video')].map(async (video, index) => {
      // Claim the frame before pausing. The Player's recovery/runtime paths
      // otherwise interpret this test-only pause as interrupted autoplay and
      // start the video again while the screenshot oracle is settling.
      video.dataset.holdFrame = 'true';
      video.pause(); video.autoplay = false; video.controls = false;
      if (video.readyState < 1) await eventOrTimeout(video, 'loadedmetadata');
      if (!Number.isFinite(video.duration)) return;
      const at = Math.max(0, Math.min(times[index] ?? 0, Math.max(0, video.duration - .03)));
      if (Math.abs(video.currentTime - at) <= .0001) {
        // currentTime may already have been reset while the compositor still
        // holds a stale autoplay frame. Force a decode before seeking back.
        const nudge = at + .03 <= video.duration ? at + .03 : Math.max(0, at - .03);
        if (Math.abs(nudge - at) > .0001) {
          const nudged = eventOrTimeout(video, 'seeked');
          try { video.currentTime = nudge; } catch { return; }
          await nudged;
        }
      }
      if (Math.abs(video.currentTime - at) > .0001) {
        const sought = eventOrTimeout(video, 'seeked');
        try { video.currentTime = at; } catch { return; }
        await sought;
      }
      await paintedFrame(video);
    }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return [...document.querySelectorAll('video')].map((video) => ({
      src: video.currentSrc || video.src,
      readyState: video.readyState,
      networkState: video.networkState,
      currentTime: video.currentTime,
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    }));
  })()`);
}

async function stableCapture(win) {
  let previous = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const image = await win.webContents.capturePage();
    const bitmap = image.getBitmap();
    if (previous && bitmap.equals(previous.bitmap)) return previous.image;
    previous = { image, bitmap };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return previous.image;
}

function compare(reference, actual, rasterToleranceBoxes = [], canvas = null) {
  const aSize = reference.getSize();
  const bSize = actual.getSize();
  if (aSize.width !== bSize.width || aSize.height !== bSize.height) {
    return { fraction: 1, differing: -1, total: -1,
      size: `${aSize.width}x${aSize.height} vs ${bSize.width}x${bSize.height}`, diff: reference };
  }
  const a = reference.getBitmap();
  const b = actual.getBitmap();
  const out = Buffer.alloc(a.length);
  const compared = comparePixelBuffers(a, b, aSize.width, aSize.height, {
    channelTolerance: CHANNEL_TOLERANCE,
    edgeChannelTolerance: 160,
    // Native images are in device pixels. PDF glyph and bitmap interpolation
    // can land up to two CSS pixels away from the screenshot compositor while
    // retaining identical DOM geometry; larger motion still fails clearly.
    radius: Math.max(1, Math.ceil(screen.getPrimaryDisplay().scaleFactor * 2)),
    highToleranceAreas: canvas ? rasterToleranceBoxes.map((box) => ({
      x: Math.floor(box.x * aSize.width / canvas.w),
      y: Math.floor(box.y * aSize.height / canvas.h),
      w: Math.ceil(box.w * aSize.width / canvas.w),
      h: Math.ceil(box.h * aSize.height / canvas.h),
      channelTolerance: box.channelTolerance,
      ...(box.spatialTolerance ? {
        radius: Math.ceil(box.spatialTolerance * aSize.width / canvas.w),
      } : {}),
    })) : [],
  });
  for (let i = 0; i < a.length; i += 4) {
    const bad = compared.different[i / 4] === 1;
    out[i] = bad ? 255 : a[i] >> 1;
    out[i + 1] = bad ? 0 : a[i + 1] >> 1;
    out[i + 2] = bad ? 255 : a[i + 2] >> 1;
    out[i + 3] = 255;
  }
  return { fraction: compared.differing / compared.total,
    differing: compared.differing, total: compared.total,
    size: `${aSize.width}x${aSize.height}`, diff: nativeImage.createFromBitmap(out, aSize) };
}

function serveAsset(request) {
  try {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const absolute = resolve(activeDeckDir, relative);
    if (!absolute.startsWith(resolve(activeDeckDir) + require('node:path').sep)) return new Response('Forbidden', { status: 403 });
    const size = statSync(absolute).size;
    const range = request.headers.get('Range');
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const stream = Readable.toWeb(createReadStream(absolute, { start, end }));
    return new Response(stream, { status: match ? 206 : 200, headers });
  } catch (error) { return new Response(String(error), { status: 404 }); }
}

const RASTER_PDF = `
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
out, width, height = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
for index, page in enumerate(doc):
    matrix = pymupdf.Matrix(width / page.rect.width, height / page.rect.height)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    pix.save(f'{out}/{index}.png')
`;

const RASTER_PAGE = `
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
page = doc[0]
width, height = int(sys.argv[3]), int(sys.argv[4])
matrix = pymupdf.Matrix(width / page.rect.width, height / page.rect.height)
page.get_pixmap(matrix=matrix, alpha=False).save(sys.argv[2])
`;
