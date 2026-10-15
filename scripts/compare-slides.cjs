/**
 * Does the exported HTML *look* like the slide?
 *
 * Run *by Electron*: `electron scripts/compare-slides.cjs <job.json>`.
 *
 * Every other check in this repository compares deck JSON against deck JSON,
 * and for an export that writes `left/top/width/height` and reads the same
 * numbers back, that is very nearly a tautology: a shape can export as an empty
 * div and a cropped photo can export squashed, and the round trip still says
 * "identical". Only pixels can tell.
 *
 * So: paint the slide twice — once with the real Player from an exported
 * bundle, once by opening the authoring file the way a browser would — and
 * compare the two images. The Player is the definition of correct, because it
 * is what the projector runs.
 */
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, nativeImage } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SETTLE_MS = job.settleMs ?? 400;
/** Per-channel slack, for the odd antialiased edge pixel. */
const CHANNEL_TOLERANCE = job.channelTolerance ?? 24;

app.disableHardwareAcceleration();
// A helper, not an app: keep it out of the macOS Dock, where every run would
// otherwise put an Electron icon for as long as it lasts.
if (process.platform === 'darwin') app.dock.hide();

app.whenReady().then(async () => {
  mkdirSync(job.outDir, { recursive: true });
  const win = new BrowserWindow({
    width: job.canvas.w,
    height: job.canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  try {
    const results = [];
    for (const slide of job.slides) {
      const player = await capturePlayer(win, slide);
      const authored = await captureAuthored(win, slide);
      const comparison = compare(player, authored);
      if (comparison.fraction > (job.reportAbove ?? 0)) {
        // Written only when they differ, and written for all three: the eye
        // finds in one second what a percentage never explains.
        writeFileSync(join(job.outDir, `${slide.id}-player.png`), player.image.toPNG());
        writeFileSync(join(job.outDir, `${slide.id}-authored.png`), authored.image.toPNG());
        writeFileSync(join(job.outDir, `${slide.id}-diff.png`), comparison.diff.toPNG());
      }
      results.push({
        id: slide.id,
        fraction: comparison.fraction,
        differing: comparison.differing,
        total: comparison.total,
        size: comparison.size,
      });
    }
    writeFileSync(job.outPath, JSON.stringify({ results }), 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, slides: results.length }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});

/** The slide as the projector shows it. */
async function capturePlayer(win, slide) {
  await win.loadFile(join(job.bundleDir, 'index.html'), { hash: String(slide.number) });
  await settle(win);
  // Builds start hidden; the authoring file has no such notion, so compare the
  // finished slide against the finished slide.
  await win.webContents.executeJavaScript(REVEAL_BUILDS);
  await win.webContents.executeJavaScript(NEUTRAL_PAGE);
  await win.webContents.executeJavaScript(pinVideos(slide.videoStarts ?? []));
  return captureStable(win);
}

/** The same slide as a browser shows the file the author edits. */
async function captureAuthored(win, slide) {
  await win.loadURL(pathToFileURL(slide.page).href);
  await settle(win);
  const rect = await win.webContents.executeJavaScript(
    `(${FRAME_SLIDE})(${JSON.stringify(slide.sourceNumber ?? 1)})`,
  );
  await win.webContents.executeJavaScript(pinVideos(slide.videoStarts ?? []));
  return captureStable(win, rect);
}

/**
 * Capture a frame the page has stopped changing.
 *
 * A decoded photograph, a web font, an auto-fit pass: each lands a frame or
 * two after the event that promised it, and a screenshot taken in between is a
 * picture of a slide mid-assembly. Rather than guess at a sleep long enough for
 * all of them, shoot twice and accept the frame only once two in a row agree.
 */
async function captureStable(win, rect) {
  let previous = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await win.webContents.executeJavaScript(NEXT_PAINT);
    const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
    const bitmap = image.getBitmap();
    if (previous && bitmap.equals(previous.bitmap)) return previous;
    previous = { image, bitmap, size: image.getSize() };
    await new Promise((wait) => setTimeout(wait, 120));
  }
  return previous;
}

async function settle(win) {
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((wait) => setTimeout(wait, SETTLE_MS));
}

/**
 * Count the pixels that differ, and draw where.
 *
 * Bitmaps are BGRA. A pixel counts as different when any channel is off by
 * more than the tolerance, which forgives antialiasing without forgiving a
 * missing box or a squashed photograph.
 */
function compare(player, authored) {
  const size = player.size;
  if (size.width !== authored.size.width || size.height !== authored.size.height) {
    return {
      fraction: 1,
      differing: -1,
      total: -1,
      size: `${size.width}x${size.height} vs ${authored.size.width}x${authored.size.height}`,
      diff: player.image,
    };
  }

  const a = player.bitmap;
  const b = authored.bitmap;
  const out = Buffer.alloc(a.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    const off = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    const bad = off > CHANNEL_TOLERANCE;
    if (bad) differing++;
    // Difference in magenta over a dimmed copy of what the player drew.
    out[i] = bad ? 255 : a[i] >> 1;
    out[i + 1] = bad ? 0 : a[i + 1] >> 1;
    out[i + 2] = bad ? 255 : a[i + 2] >> 1;
    out[i + 3] = 255;
  }

  const total = a.length / 4;
  return {
    fraction: differing / total,
    differing,
    total,
    size: `${size.width}x${size.height}`,
    diff: nativeImage.createFromBitmap(out, size),
  };
}

/**
 * Stop time.
 *
 * A playing video shows a different frame every capture, so two pictures of the
 * same slide would never agree. Both sides are paused at the same point — the
 * deck's own in-point for each video, in paint order — which compares
 * everything about a video except which frame it drifted to.
 */
function pinVideos(starts) {
  return `(() => {
    const videos = [...document.querySelectorAll('video')];
    return Promise.all(videos.map((video, index) => new Promise((done) => {
      const at = ${JSON.stringify(starts)}[index] ?? 0;
      // Tell the Player this frame is ours now, so it does not resume playback
      // to recover from what looks to it like an unwanted pause.
      video.dataset.holdFrame = 'true';
      video.pause();
      video.autoplay = false;
      const seek = () => {
        if (Math.abs(video.currentTime - at) < 0.05) return done(true);
        video.addEventListener('seeked', () => done(true), { once: true });
        video.currentTime = at;
      };
      if (video.readyState >= 1) seek();
      else video.addEventListener('loadedmetadata', seek, { once: true });
      setTimeout(() => done(false), 3000);
    })));
  })()`;
}

/** Reveal every build step, so a build-in slide is compared fully drawn. */
const REVEAL_BUILDS = `(() => {
  for (const node of document.querySelectorAll('.slide [data-element-id]')) {
    node.style.visibility = 'visible';
  }
  return true;
})()`;

/**
 * Same ground under both pictures.
 *
 * A slide with no background of its own shows whatever is behind it, and the
 * two pages have different chrome — the player letterboxes, the authoring file
 * puts the slide on a dark page so it reads as a slide. That is page
 * furniture, not the slide, so both are stood on the same white.
 */
const NEUTRAL_PAGE = `(() => {
  document.documentElement.style.background = '#ffffff';
  if (document.body) document.body.style.background = '#ffffff';
  return true;
})()`;

/**
 * Put the authoring file's slide at the top-left and report its box.
 *
 * The page deliberately pads and shadows the slide so it looks like a slide
 * when opened; that framing is not part of the comparison.
 */
const FRAME_SLIDE = `(number => {
  document.documentElement.style.background = '#ffffff';
  const body = document.body;
  body.style.margin = '0';
  body.style.padding = '0';
  body.style.background = '#ffffff';
  const slides = [...document.querySelectorAll('section.slide, [data-slide-id]')];
  const slide = slides[number - 1];
  if (!slide) throw new Error('Authored slide ' + number + ' is missing');
  // A multi-slide authoring document lays later sections below the viewport.
  // Isolate the requested section before capturing so its authored 1920x1080
  // canvas is framed at the origin just like a one-slide fixture.
  for (const candidate of slides) {
    if (candidate !== slide) candidate.style.display = 'none';
  }
  slide.style.boxShadow = 'none';
  slide.style.margin = '0';
  window.scrollTo(0, 0);
  const box = slide.getBoundingClientRect();
  return {
    x: Math.round(box.left), y: Math.round(box.top),
    width: Math.round(box.width), height: Math.round(box.height),
  };
})`;

/** Offscreen rendering paints on its own schedule; wait for the frame to land. */
const NEXT_PAINT = `new Promise((done) => requestAnimationFrame(
  () => requestAnimationFrame(() => done(true))))`;
