/**
 * Pixel and geometry parity for Agent scratchpad HTML.
 *
 * Run by Electron: `electron scripts/compare-scratchpad.cjs <job.json>`.
 * The job contains ordinary rendered pages and the corresponding pages after
 * DeckWerk's scratchpad chrome has been injected. We paint both at 1:1 and at
 * a realistic panel size, then inspect contact-sheet cells as well.
 */
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const CHANNEL_TOLERANCE = 24;

app.disableHardwareAcceleration();
// A helper, not an app: keep it out of the macOS Dock, where every run would
// otherwise put an Electron icon for as long as it lasts.
if (process.platform === 'darwin') app.dock.hide();

app.whenReady().then(async () => {
  try {
    const results = [];
    for (const page of job.pages) results.push(await comparePage(page));
    mkdirSync(dirname(job.outPath), { recursive: true });
    writeFileSync(job.outPath, JSON.stringify({ results }, null, 2));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});

async function comparePage(page) {
  const directWin = browserWindow(job.canvas.w, job.canvas.h);
  const unitWin = browserWindow(job.canvas.w + 24, job.canvas.h + 24);
  const panelWin = browserWindow(job.panel.w, job.panel.h);
  const contactWin = browserWindow(job.contact.w, job.contact.h);
  const direct = [];
  for (let index = 0; index < page.slideCount; index += 1) {
    await directWin.loadURL(pathToFileURL(page.directPath).href);
    await settle(directWin);
    const rect = await selectDirectSlide(directWin, index);
    direct.push({
      capture: await captureStable(directWin, rect),
      probes: await probes(directWin, page.probeSelector, directSlideExpression(index)),
    });
  }

  const slides = [];
  for (let index = 0; index < page.slideCount; index += 1) {
    const slidesUrl = `${pathToFileURL(page.slidesPath).href}?slide=${index + 1}`;
    await unitWin.loadURL(slidesUrl);
    await settle(unitWin);
    await hideControls(unitWin);
    const unitRect = await activeSlideRect(unitWin);
    const unit = await captureStable(unitWin, unitRect);
    const unitProbes = await probes(unitWin, page.probeSelector, activeSlideExpression());

    await panelWin.loadURL(slidesUrl);
    await settle(panelWin);
    await hideControls(panelWin);
    const scaledRect = await activeSlideRect(panelWin);
    const scaled = await captureStable(panelWin, scaledRect);
    const scaledProbes = await probes(panelWin, page.probeSelector, activeSlideExpression());
    const scaledViewport = await panelWin.webContents.executeJavaScript(
      '({ innerWidth, innerHeight, htmlWidth: document.documentElement.getBoundingClientRect().width, bodyWidth: document.body.getBoundingClientRect().width })');
    const resized = direct[index].capture.image.resize({
      width: scaled.size.width,
      height: scaled.size.height,
      quality: 'best',
    });

    slides.push({
      unitPixels: compareBitmaps(direct[index].capture, unit),
      scaledPixels: compareBitmaps(
        { image: resized, bitmap: resized.getBitmap(), size: resized.getSize() },
        scaled,
      ),
      unitGeometry: compareProbes(direct[index].probes, unitProbes),
      scaledGeometry: compareProbes(direct[index].probes, scaledProbes),
      unitRect,
      scaledRect,
      scaledViewport,
      unitSize: `${unit.size.width}x${unit.size.height}`,
      scaledSize: `${scaled.size.width}x${scaled.size.height}`,
    });
  }

  await contactWin.loadURL(pathToFileURL(page.contactPath).href);
  await settle(contactWin);
  await hideControls(contactWin);
  const contact = [];
  for (let index = 0; index < page.slideCount; index += 1) {
    const expression = contactSlideExpression(index);
    const rect = await rectFor(contactWin, expression);
    const capture = await captureStable(contactWin, rect);
    const contactProbes = await probes(contactWin, page.probeSelector, expression);
    const resized = direct[index].capture.image.resize({
      width: capture.size.width,
      height: capture.size.height,
      quality: 'best',
    });
    contact.push({
      pixels: compareBitmaps(
        { image: resized, bitmap: resized.getBitmap(), size: resized.getSize() },
        capture,
      ),
      geometry: compareProbes(direct[index].probes, contactProbes),
      rect,
      size: `${capture.size.width}x${capture.size.height}`,
    });
  }
  return { id: page.id, slides, contact };
}

function browserWindow(width, height) {
  return new BrowserWindow({
    width, height, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
}

async function selectDirectSlide(win, index) {
  return win.webContents.executeJavaScript(`(() => {
    const slides = [...document.querySelectorAll('body > section.slide, body > .slide')];
    slides.forEach((slide, i) => { slide.style.display = i === ${index} ? '' : 'none'; });
    document.body.style.padding = '0';
    slides[${index}].style.margin = '0';
    const rect = slides[${index}].getBoundingClientRect();
    return ${rectObject('rect')};
  })()`);
}

function directSlideExpression(index) {
  return `document.querySelectorAll('body > section.slide, body > .slide')[${index}]`;
}

function activeSlideExpression() {
  return `document.querySelector('.agent-scratchpad-frame.agent-scratchpad-active > .slide')`;
}

function contactSlideExpression(index) {
  return `document.querySelectorAll('.agent-scratchpad-cell > .agent-scratchpad-frame > .slide')[${index}]`;
}

async function activeSlideRect(win) {
  return rectFor(win, activeSlideExpression());
}

async function rectFor(win, expression) {
  return win.webContents.executeJavaScript(`(() => {
    const node = ${expression};
    if (!node) throw new Error('scratchpad slide is missing');
    const rect = node.getBoundingClientRect();
    return ${rectObject('rect')};
  })()`);
}

async function probes(win, selector, slideExpression) {
  return win.webContents.executeJavaScript(`(() => {
    const slide = ${slideExpression};
    if (!slide) throw new Error('probe slide is missing');
    const root = slide.getBoundingClientRect();
    return [...slide.querySelectorAll(${JSON.stringify(selector)})].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute('data-probe') || node.getAttribute('data-element-id') || node.tagName,
        x: (rect.left - root.left) / root.width,
        y: (rect.top - root.top) / root.height,
        w: rect.width / root.width,
        h: rect.height / root.height,
      };
    });
  })()`);
}

function compareProbes(expected, actual) {
  if (expected.length !== actual.length) return { maxDelta: 1, expected: expected.length, actual: actual.length };
  let maxDelta = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].id !== actual[index].id) return { maxDelta: 1, expected: expected.length, actual: actual.length };
    for (const key of ['x', 'y', 'w', 'h']) {
      maxDelta = Math.max(maxDelta, Math.abs(expected[index][key] - actual[index][key]));
    }
  }
  return { maxDelta, expected: expected.length, actual: actual.length };
}

function compareBitmaps(left, right) {
  if (left.size.width !== right.size.width || left.size.height !== right.size.height) {
    return { fraction: 1, size: `${left.size.width}x${left.size.height} vs ${right.size.width}x${right.size.height}` };
  }
  const a = left.bitmap;
  const b = right.bitmap;
  let differing = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    if (Math.max(
      Math.abs(a[offset] - b[offset]),
      Math.abs(a[offset + 1] - b[offset + 1]),
      Math.abs(a[offset + 2] - b[offset + 2]),
    ) > CHANNEL_TOLERANCE) differing += 1;
  }
  const total = a.length / 4;
  return { fraction: differing / total, differing, total, size: `${left.size.width}x${left.size.height}` };
}

async function captureStable(win, rect) {
  const captureRect = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height),
  };
  let previous = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await nextPaint(win);
    const image = await win.webContents.capturePage(captureRect);
    const bitmap = image.getBitmap();
    if (previous && bitmap.equals(previous.bitmap)) return previous;
    previous = { image, bitmap, size: image.getSize() };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return previous;
}

async function settle(win) {
  await win.webContents.executeJavaScript(`Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    ...[...document.images].map((image) => image.decode().catch(() => null))
  ]).then(() => true)`);
  await nextPaint(win);
}

async function hideControls(win) {
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.agent-scratchpad-controls, .agent-scratchpad-number')
      .forEach((node) => { node.style.visibility = 'hidden'; });
  })()`);
}

function nextPaint(win) {
  return win.webContents.executeJavaScript(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
}

function rectObject(variable) {
  return `{ x: ${variable}.left, y: ${variable}.top, width: ${variable}.width, height: ${variable}.height }`;
}
