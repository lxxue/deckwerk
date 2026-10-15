import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backgroundElectronBinary } from '../src/cli/backgroundElectron.js';
import { scratchpadDocument } from '../src/server/collabServer.js';
import { slidesToHtml } from '../src/shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';
import type { Slide } from '../src/shared/deck.js';

const electron = (() => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : '';
  } catch {
    return '';
  }
})();

type PixelComparison = { fraction: number; size: string };
type GeometryComparison = { maxDelta: number; expected: number; actual: number };
type ScratchpadComparison = {
  id: string;
  slides: Array<{
    unitPixels: PixelComparison;
    scaledPixels: PixelComparison;
    unitGeometry: GeometryComparison;
    scaledGeometry: GeometryComparison;
    unitRect: { x: number; y: number; width: number; height: number };
    scaledRect: { x: number; y: number; width: number; height: number };
    scaledViewport: { innerWidth: number; innerHeight: number; htmlWidth: number; bodyWidth: number };
    unitSize: string;
    scaledSize: string;
  }>;
  contact: Array<{
    pixels: PixelComparison;
    geometry: GeometryComparison;
    rect: { x: number; y: number; width: number; height: number };
    size: string;
  }>;
};

const PIXEL_TOLERANCE_1X = 0.002;
const PIXEL_TOLERANCE_SCALED = 0.05;
const GEOMETRY_TOLERANCE = 0.001;

describe.skipIf(!electron)('Agent scratchpad rendering parity', () => {
  let workDir = '';
  let results: ScratchpadComparison[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'scratchpad-parity-'));
    const pages = [
      await writePage(workDir, 'authored-grid', authoredGridPage(), '[data-probe]'),
      await writePage(workDir, 'imported-native', importedPage(), '[data-element-id]'),
    ];
    const jobPath = join(workDir, 'job.json');
    const outPath = join(workDir, 'results.json');
    await writeFile(jobPath, JSON.stringify({
      canvas: { w: 1920, h: 1080 },
      panel: { w: 760, h: 620 },
      contact: { w: 1000, h: 700 },
      pages,
      outPath,
    }), 'utf8');
    await runElectron(jobPath);
    results = (JSON.parse(await readFile(outPath, 'utf8')) as { results: ScratchpadComparison[] }).results;
  }, 60_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('matches direct rendering at 1:1 for authored and imported HTML', () => {
    expect(results.map((result) => result.id)).toEqual(['authored-grid', 'imported-native']);
    const failures = results.flatMap((result) => result.slides.flatMap((slide, index) => [
      ...(slide.unitPixels.fraction > PIXEL_TOLERANCE_1X
        ? [`${result.id} slide ${index + 1} (${slide.unitSize}, rect ${JSON.stringify(slide.unitRect)}): ${(slide.unitPixels.fraction * 100).toFixed(2)}% pixels differ`]
        : []),
      ...(slide.unitGeometry.maxDelta > GEOMETRY_TOLERANCE
        ? [`${result.id} slide ${index + 1}: unit geometry delta ${slide.unitGeometry.maxDelta}`]
        : []),
    ]));
    expect(failures).toEqual([]);
  });

  it('preserves layout when fitted into the real scratchpad panel size', () => {
    const failures = results.flatMap((result) => result.slides.flatMap((slide, index) => [
      ...(slide.scaledPixels.fraction > PIXEL_TOLERANCE_SCALED
        ? [`${result.id} slide ${index + 1} (${slide.scaledSize}, rect ${JSON.stringify(slide.scaledRect)}, viewport ${JSON.stringify(slide.scaledViewport)}): ${(slide.scaledPixels.fraction * 100).toFixed(2)}% pixels differ`]
        : []),
      ...(slide.scaledGeometry.maxDelta > GEOMETRY_TOLERANCE
        ? [`${result.id} slide ${index + 1}: scaled geometry delta ${slide.scaledGeometry.maxDelta}`]
        : []),
    ]));
    expect(failures).toEqual([]);
  });

  it('keeps every contact-sheet thumbnail faithful to its real slide', () => {
    const failures = results.flatMap((result) => result.contact.flatMap((slide, index) => [
      ...(slide.pixels.fraction > PIXEL_TOLERANCE_SCALED
        ? [`${result.id} contact ${index + 1} (${slide.size}, rect ${JSON.stringify(slide.rect)}): ${(slide.pixels.fraction * 100).toFixed(2)}% pixels differ`]
        : []),
      ...(slide.geometry.maxDelta > GEOMETRY_TOLERANCE
        ? [`${result.id} contact ${index + 1}: geometry delta ${slide.geometry.maxDelta}`]
        : []),
    ]));
    expect(failures).toEqual([]);
  });
});

async function writePage(
  root: string,
  id: string,
  html: string,
  probeSelector: string,
): Promise<{ id: string; directPath: string; slidesPath: string; contactPath: string; slideCount: number; probeSelector: string }> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const directPath = join(dir, 'direct.html');
  const slidesPath = join(dir, 'scratchpad-slides.html');
  const contactPath = join(dir, 'scratchpad-contact.html');
  await Promise.all([
    writeFile(directPath, html, 'utf8'),
    writeFile(slidesPath, scratchpadDocument(html, 'slides'), 'utf8'),
    writeFile(contactPath, scratchpadDocument(html, 'contact'), 'utf8'),
  ]);
  return {
    id, directPath, slidesPath, contactPath, probeSelector,
    slideCount: (html.match(/<section\b[^>]*class=["'][^"']*\bslide\b/gi) ?? []).length,
  };
}

function authoredGridPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; width: 1920px; min-height: 1080px; background: white; }
.slide { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #fff; color: #172033; }
.intro { display: grid; grid-template-columns: 570px 1fr; gap: 120px; align-items: center; padding: 120px 150px; }
.portrait { width: 500px; height: 500px; border-radius: 50%; background: #5476b8; box-shadow: inset 0 0 0 28px #dce6fa; }
.content { display: grid; gap: 26px; align-content: center; }
h1, p { margin: 0; }
h1 { font: 400 84px/1 Arial, sans-serif; letter-spacing: -1px; }
.role { font: 40px/1.25 Arial, sans-serif; color: #556070; }
.facts { display: grid; gap: 24px; }
.fact { display: grid; grid-template-columns: 225px 1fr; gap: 30px; font: 33px/1.28 Arial, sans-serif; }
.label { font-weight: 700; }
.source { position: absolute; right: 150px; bottom: 56px; font: 18px Arial, sans-serif; color: #78808c; }
.diagram { display: flex; gap: 54px; align-items: center; justify-content: center; }
.node { width: 360px; height: 220px; display: grid; place-items: center; border: 12px solid #27395d; border-radius: 34px; font: 700 48px Arial, sans-serif; }
.node.emphasis { transform: translateY(-36px) rotate(-2deg); background: #e6edff; }
</style></head><body>
<section class="slide intro">
  <div class="portrait" data-probe="portrait"></div>
  <div class="content" data-probe="content"><h1 data-probe="title">Alexander Bergman</h1><p class="role" data-probe="role">Chief Data Officer &amp; VP Software Engineering</p>
    <div class="facts" data-probe="facts"><div class="fact"><div class="label">Stanford</div><div>PhD, Electrical Engineering</div></div><div class="fact"><div class="label">Research</div><div>Neural rendering and generative video</div></div></div>
  </div><p class="source" data-probe="source">Source: professional profile</p>
</section>
<section class="slide diagram">
  <div class="node" data-probe="input">Input</div><div class="node emphasis" data-probe="model">Model</div><div class="node" data-probe="output">Output</div>
</section>
</body></html>`;
}

function importedPage(): string {
  const slides: Slide[] = [
    {
      id: 'native-one', name: 'Native one', notes: '', skipped: false,
      background: { color: '#f8fafc', image: null }, timeline: [],
      morphFromPrevious: false, morphDuration: 1000,
      elements: [
        {
          id: 'native-title', type: 'text', x: 160, y: 130, w: 1600, h: 130,
          rot: 0, z: 1, opacity: 1, class: ['role-title'], style: { color: '#14213d', 'font-size': '78px' },
          html: 'Imported scratchpad', align: 'center', valign: 'middle',
        },
        {
          id: 'native-shape', type: 'shape', x: 430, y: 390, w: 1060, h: 360,
          rot: -2, z: 2, opacity: 1, class: [], style: {}, shape: 'rect',
          fill: '#dbeafe', stroke: '#31588f', strokeWidth: 10,
          arrowStart: false, arrowEnd: false, radius: 42, path: null, pathSize: null, control: null,
        },
        {
          id: 'native-body', type: 'text', x: 540, y: 500, w: 840, h: 130,
          rot: 0, z: 3, opacity: 1, class: ['role-body'], style: { color: '#1f2937', 'font-size': '46px' },
          html: 'Editable native objects', align: 'center', valign: 'middle',
        },
      ],
    },
  ];
  return slidesToHtml(slides, { w: 1920, h: 1080 }, { typeCss: PLAYER_TYPE_CSS });
}

async function runElectron(jobPath: string): Promise<void> {
  const script = fileURLToPath(new URL('../scripts/compare-scratchpad.cjs', import.meta.url));
  const binary = await backgroundElectronBinary(electron);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [script, jobPath], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `scratchpad comparison failed with exit code ${code}`)));
  });
}
