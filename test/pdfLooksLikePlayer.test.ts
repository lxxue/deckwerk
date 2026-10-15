// @vitest-environment jsdom
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backgroundElectronBinary } from '../src/cli/backgroundElectron.js';
import { exportDeck } from '../src/main/exportDeck.js';
import { loadDeck } from '../src/main/deckStore.js';
import { pdfSteps } from '../src/shared/pdfExport.js';
import { resolveState } from '../src/shared/timeline.js';

interface PdfComparison {
  deck: string;
  id: string;
  step: number;
  fraction: number;
  differing: number;
  total: number;
  size: string;
}

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const PRINT_PAGE = join(process.cwd(), 'out/renderer/print/index.html');
const PLAYER = join(process.cwd(), 'out/export/player.js');
const electron = (() => {
  try { return createRequire(import.meta.url)('electron') as unknown as string; } catch { return ''; }
})();
const pythonHasPdf = existsSync(PYTHON)
  && spawnSync(PYTHON, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;
const runnable = Boolean(electron) && pythonHasPdf && existsSync(PRINT_PAGE) && existsSync(PLAYER);
const TOLERANCE = 0.002;
const PDF_FIXTURE_DECKS = [
  'agent-reference',
  'demo-deck',
] as const;
const PDF_SMOKE_DECKS = ['demo-deck'] as const;

/**
 * This is a visual test of the file users receive, not a comparison of two
 * deck data structures. The ordinary suite covers representative states
 * from the compact, media-bearing demo fixture. `PDF_PIXEL_EXHAUSTIVE=1`
 * expands that to the explicitly anonymized/generated fixture allowlist.
 */
describe.skipIf(!runnable)('PDF pages, against the real Player', () => {
  let work = '';
  let results: PdfComparison[] = [];
  let expectedPages = 0;
  let deckCount = 0;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'pdf-pixels-'));
    const deckRoot = join(process.cwd(), 'decks');
    const requested = process.env.PDF_PIXEL_DECK;
    const requestedSlide = process.env.PDF_PIXEL_SLIDE;
    const exhaustive = process.env.PDF_PIXEL_EXHAUSTIVE === '1'
      || Boolean(requested || requestedSlide);
    // Keep personal and local working decks out of this regression. Only
    // generated or deliberately minimal fixtures belong in this allowlist.
    const names = requested
      ? [requested]
      : exhaustive ? [...PDF_FIXTURE_DECKS] : [...PDF_SMOKE_DECKS];
    const jobs = [];
    for (const name of names) {
      const deckDir = join(deckRoot, name);
      const deck = await loadDeck(deckDir);
      const profiledSources = new Set<string>();
      const rasterSources = new Set(deck.slides.flatMap((slide) => [
        slide.background.image,
        ...slide.elements.flatMap((element) => element.type === 'image' ? [element.src] : []),
      ]).filter((src): src is string => typeof src === 'string'
        && /\.(?:png|jpe?g|webp)$/i.test(src)));
      await Promise.all([...rasterSources].map(async (src) => {
        const bytes = await readFile(join(deckDir, src));
        if (bytes.includes(Buffer.from('iCCP')) || bytes.includes(Buffer.from('ICC_PROFILE'))) {
          profiledSources.add(src);
        }
      }));
      const bundleDir = join(work, `${name}-player`);
      const outDir = join(work, `${name}-results`);
      await exportDeck(deckDir, deck, bundleDir);
      const representativeIds = exhaustive ? null : representativeSlides(deck);
      const pages = deck.slides.flatMap((slide, slideIndex) => {
        if (slide.skipped) return [];
        if (requestedSlide && slide.id !== requestedSlide) return [];
        if (representativeIds && !representativeIds.has(slide.id)) return [];
        return pdfSteps(slide, 'every').map((step) => {
          const state = resolveState(slide, step);
          return {
            id: slide.id,
            slide: slideIndex,
            step,
            videoTimes: [...slide.elements]
              .sort((a, b) => a.z - b.z)
              .filter((element) => element.type === 'video')
              .map((element) => state.seeks.get(element.id) ?? element.start),
            rasterToleranceBoxes: [
              ...(slide.background.image && profiledSources.has(slide.background.image)
                ? [{ x: 0, y: 0, w: deck.canvas.w, h: deck.canvas.h,
                  channelTolerance: 96 }] : []),
              ...slide.elements.flatMap((element) => {
                const channelTolerance = element.type === 'video' ? 64
                  : element.type === 'image' && profiledSources.has(element.src) ? 96
                    : element.type === 'image' ? 64
                      : element.type === 'text' ? 32 : null;
                if (channelTolerance === null) return [];
                const radians = element.rot * Math.PI / 180;
                const w = Math.abs(Math.cos(radians)) * element.w
                  + Math.abs(Math.sin(radians)) * element.h;
                const h = Math.abs(Math.sin(radians)) * element.w
                  + Math.abs(Math.cos(radians)) * element.h;
                return [{ x: element.x + (element.w - w) / 2,
                  y: element.y + (element.h - h) / 2, w, h, channelTolerance,
                  ...(element.type === 'text' ? { spatialTolerance: 5 } : {}) }];
              }),
            ],
          };
        });
      });
      expectedPages += pages.length;
      jobs.push({
        name, deckDir, bundleDir, outDir, canvas: deck.canvas, mode: 'every', pages,
        ...(requestedSlide ? { slideFilter: requestedSlide } : {}),
      });
    }
    deckCount = jobs.length;

    const outPath = join(work, 'comparison.json');
    const jobPath = join(work, 'job.json');
    await writeFile(jobPath, JSON.stringify({
      decks: jobs,
      outPath,
      python: PYTHON,
      printPage: PRINT_PAGE,
      preload: resolve('scripts/pdf-fidelity-preload.cjs'),
      reportAbove: TOLERANCE,
    }), 'utf8');
    const electronOutput = await runElectron(
      resolve('scripts/compare-pdf.cjs'), jobPath);
    if (!existsSync(outPath)) throw new Error(`PDF comparison returned without results: ${electronOutput}`);
    results = (JSON.parse(await readFile(outPath, 'utf8')) as { results: PdfComparison[] }).results;
  }, 1_800_000);

  afterAll(async () => {
    if (work && process.env.PDF_KEEP_RESULTS !== '1') await rm(work, { recursive: true, force: true });
    else if (work) process.stderr.write(`PDF pixel artifacts: ${work}\n`);
  });

  it('covers a real media fixture with representative pages', () => {
    expect(deckCount).toBeGreaterThanOrEqual(
      process.env.PDF_PIXEL_DECK
        ? 1
        : process.env.PDF_PIXEL_EXHAUSTIVE === '1' ? PDF_FIXTURE_DECKS.length : 1,
    );
    expect(results).toHaveLength(expectedPages);
    expect(results.every((result) => result.total > 1_000_000)).toBe(true);
  });

  it('matches each Player state pixel by pixel', () => {
    const wrong = results
      .filter((result) => result.fraction > TOLERANCE)
      .map((result) => `${result.deck}/${result.id} step ${result.step}: ${(result.fraction * 100).toFixed(3)}% (${result.size})`);
    expect(wrong).toEqual([]);
  });
});

describe.skipIf(runnable)('PDF pages, against the real Player (skipped)', () => {
  it('needs the built renderer, Electron, and PyMuPDF', () => expect(runnable).toBe(false));
});

async function runElectron(script: string, jobPath: string): Promise<string> {
  const binary = await backgroundElectronBinary(electron);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [script, jobPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (error += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0
      ? resolvePromise(output)
      : reject(new Error(error.trim() || output.trim()
        || `PDF comparison failed with exit code ${code}${signal ? ` (${signal})` : ''}`)));
  });
}

/** First, last, and the most feature-rich slide give every fixture a stable
 * visual smoke test while preserving an opt-in exhaustive sweep above. */
function representativeSlides(deck: Awaited<ReturnType<typeof loadDeck>>): Set<string> {
  const visible = deck.slides.filter((slide) => !slide.skipped);
  if (visible.length <= 3) return new Set(visible.map((slide) => slide.id));
  const score = (slide: (typeof visible)[number]): number =>
    slide.elements.length
    + slide.timeline.length * 10
    + slide.elements.reduce((total, element) => total
      + (element.type === 'video' ? 20 : 0)
      + (element.type === 'image' ? 8 : 0)
      + (element.type === 'shape' && element.path ? 6 : 0)
      + (element.rot !== 0 ? 4 : 0), 0);
  const richest = [...visible].sort((left, right) => score(right) - score(left))[0];
  return new Set([visible[0].id, richest.id, visible[visible.length - 1].id]);
}
