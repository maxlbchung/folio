import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';

const [script, styles] = await Promise.all([
  readFile(new URL('../dist-smoke/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-smoke/app.css', import.meta.url), 'utf8')
]);

const smokeServer = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/migration-seed') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body></body></html>');
    return;
  }
  if (request.url === '/app.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(script);
    return;
  }
  if (request.url === '/app.css') {
    response.setHeader('Content-Type', 'text/css; charset=utf-8');
    response.end(styles);
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((resolve, reject) => {
  smokeServer.once('error', reject);
  smokeServer.listen(0, '127.0.0.1', resolve);
});
const smokeAddress = smokeServer.address();
assert.ok(smokeAddress && typeof smokeAddress === 'object', 'smoke server should bind a loopback port');
const smokeUrl = `http://127.0.0.1:${smokeAddress.port}/`;

// Mirrors MIN_VERSIONS_HEIGHT in src/document/factories.ts: the versions page minimum
// height that keeps its ~158px single-column control rail inside the card (3px top
// offset + rail height + 3px bottom breathing room).
const MIN_VERSIONS_HEIGHT = 164;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter']
});

try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1800 } });
  const migrationSeedPage = await context.newPage();
  await migrationSeedPage.goto(`${smokeUrl}migration-seed`);
  await migrationSeedPage.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('folio-editor');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('folio-editor', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('autosave');
        request.result.createObjectStore('library', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('library', 'readwrite');
      transaction.objectStore('library').put({
        id: 'migration-fixture',
        title: 'Version two fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
        pageCount: 0,
        plainText: '',
        previewText: '',
        path: null,
        blob: new Blob([])
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await migrationSeedPage.close();

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const dragPointer = async (startX, startY, endX, endY) => {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY);
    await page.mouse.up();
  };

  await page.goto(smokeUrl);
  await page.locator('.library').waitFor({ state: 'visible' });
  await page.getByLabel('Delete Version two fixture').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.folio-card').count(), 1, 'database version 3 migrates version 2 library metadata into the lightweight index');
  await page.getByLabel('Delete Version two fixture').click();
  await page.getByRole('button', { name: 'Delete folio' }).click();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.folio-card').count(), 0, 'starts on an empty folio library');
  assert.equal(await page.getByRole('button', { name: 'New folio' }).count(), 1, 'home page offers a new folio action');
  assert.equal(await page.getByRole('button', { name: 'Open .folio' }).count(), 1, 'home page offers an existing folio import action');

  // Create two real local-library entries so title lookup, full-text frequency,
  // rename, reopen, ordering, and deletion are exercised before the editor suite.
  await page.getByRole('button', { name: 'New folio' }).click();
  await page.locator('.page-insert__trigger').waitFor({ state: 'visible' });
  await page.locator('.document-title').fill('Research notes');
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text/ }).click();
  await page.locator('.text-block').click();
  await page.keyboard.type('signal signal signal');
  await page.getByRole('button', { name: 'Back to folios' }).click();
  await page.getByRole('button', { name: 'New folio' }).click();
  await page.locator('.document-title').fill('Signal brief');
  await page.getByRole('button', { name: 'Back to folios' }).click();
  await page.locator('.folio-card').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.folio-card').count(), 2, 'new folios persist on the home page');
  assert.deepEqual(
    await page.getByLabel('View folios by').locator('option').allTextContents(),
    ['Last opened', 'Date created', 'Last edited', 'Title'],
    'library exposes all requested view modes'
  );

  await page.getByPlaceholder('Look up titles and text').fill('signal');
  const titleResults = page.getByRole('region', { name: 'In titles' });
  const textResults = page.getByRole('region', { name: 'In folio text' });
  assert.equal(await titleResults.locator('.folio-card').count(), 1, 'title matches appear in their own result group');
  assert.match(await titleResults.locator('.folio-card').innerText(), /Signal brief/i, 'the title match is listed first');
  assert.equal(await textResults.locator('.folio-card').count(), 1, 'text-only matches appear after title matches');
  assert.match(await textResults.locator('.folio-card').innerText(), /3 matches/i, 'text results expose and sort by frequency');
  const titleGroupBox = await titleResults.boundingBox();
  const textGroupBox = await textResults.boundingBox();
  assert.ok(titleGroupBox.y < textGroupBox.y, 'title results render above text results');
  await page.getByRole('button', { name: 'Sort ascending' }).click();
  assert.equal(await page.getByRole('button', { name: 'Sort descending' }).count(), 1, 'library switches between descending and ascending');
  await page.getByRole('button', { name: 'Clear search' }).click();

  await page.getByLabel('Edit title for Signal brief').click();
  await page.getByLabel('Folio title', { exact: true }).fill('Beacon brief');
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByText('Title updated').waitFor({ state: 'visible' });
  await page.reload();
  await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Open Research notes' }).click();
  assert.equal((await page.locator('.text-block').innerText()).trim(), 'signal signal signal', 'a persisted library folio reopens after a full reload');
  await page.getByRole('button', { name: 'Back to folios' }).click();
  await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
  const cachedLibraryOpenChangedViewNextFrame = await page.getByRole('button', { name: 'Open Research notes' }).evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return Boolean(document.querySelector('.page-stack'));
  });
  assert.ok(cachedLibraryOpenChangedViewNextFrame, 'a cached library snapshot reopens by the next animation frame');
  assert.equal((await page.locator('.text-block').innerText()).trim(), 'signal signal signal', 'a library folio reopens for editing with its text intact');

  const cleanCycleDurations = [];
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Back to folios' }).click();
    await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Open Research notes' }).click();
    await page.locator('.text-block').waitFor({ state: 'visible' });
    cleanCycleDurations.push(Date.now() - startedAt);
  }
  assert.ok(
    cleanCycleDurations.every((duration) => duration < 750),
    `six clean Home/Open cycles stay responsive without accumulating work, got ${JSON.stringify(cleanCycleDurations)}ms`
  );
  await page.getByRole('button', { name: 'Back to folios' }).click();
  await page.getByLabel('Delete Beacon brief').waitFor({ state: 'visible' });
  await page.getByLabel('Delete Beacon brief').click();
  await page.getByRole('button', { name: 'Delete folio' }).click();
  await page.getByLabel('Delete Research notes').waitFor({ state: 'visible' });
  await page.getByLabel('Delete Research notes').click();
  await page.getByRole('button', { name: 'Delete folio' }).click();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.folio-card').count(), 0, 'folio deletion removes local-library entries');
  await page.reload();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.folio-card').count(), 0, 'a deleted autosaved folio stays deleted after restart');

  await page.getByRole('button', { name: 'New folio' }).click();
  await page.locator('.page-insert__trigger').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.page-card').count(), 0, 'starts without prepopulated pages');

  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text/ }).click();
  assert.equal(await page.locator('.page-card').count(), 1, 'adds a text page');
  const textCardSpacing = await page.locator('.page-card').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom), height: element.getBoundingClientRect().height };
  });
  assert.equal(textCardSpacing.top, textCardSpacing.bottom, 'text page top and bottom spacing match');
  assert.ok(textCardSpacing.bottom <= 17, 'text page vertical spacing is halved');
  assert.ok(textCardSpacing.height >= 90 && textCardSpacing.height < 100, 'text page minimum height fits the vertical page rail');

  const titleBox = await page.locator('.document-title').boundingBox();
  const formattingBox = await page.locator('.text-toolbar').boundingBox();
  assert.ok(titleBox.x < 40, 'document title hugs the left side');
  assert.ok(formattingBox.y < 45, 'text formatting sits in the top header row');
  assert.equal(await page.getByLabel('Font family').inputValue(), 'Arial', 'font defaults to Arial without a placeholder option');
  assert.equal(await page.getByLabel('Font size').inputValue(), '3', 'font size defaults to Normal without a placeholder option');

  const text = page.locator('.text-block').first();
  await text.click();
  await page.keyboard.type('Cursor stays put');
  assert.equal((await text.innerText()).trim(), 'Cursor stays put', 'typing preserves the caret position');

  await page.keyboard.press('Control+A');
  await page.getByRole('button', { name: 'Bold' }).click();
  assert.match(await text.innerHTML(), /font-weight|<b|<strong/i, 'header formatting applies to selected text');
  await page.getByRole('button', { name: 'Anchor text to bottom' }).click();
  assert.equal(await page.locator('.page-card').first().evaluate((element) => getComputedStyle(element).alignItems), 'flex-end', 'text supports page-level vertical anchoring');

  await page.locator('.page-insert__trigger').click();
  assert.equal(await page.getByRole('button', { name: /^Rule/ }).count(), 0, 'rule pages are no longer offered');
  await page.getByRole('button', { name: /^Versions/ }).click();
  assert.equal(await page.locator('.page-card').count(), 2, 'adds versions as a separate page');
  const versionsPage = page.locator('.page-card').nth(1);
  assert.equal(await versionsPage.locator('.text-block').count(), 0, 'versions are not nested into the text page');
  const versionCardBox = await versionsPage.boundingBox();
  // Versions pages no longer open at the compact text minimum: their single-column
  // control rail (~158px) needs a taller card, so the page opens at MIN_VERSIONS_HEIGHT
  // instead of clipping/overhanging the rail.
  assert.ok(Math.abs(versionCardBox.height - MIN_VERSIONS_HEIGHT) <= 6, `version pages open at their control-rail minimum (expected ~${MIN_VERSIONS_HEIGHT}px, got ${versionCardBox.height.toFixed(2)}px)`);
  const versionRail = await page.locator('.variant-toolbar').boundingBox();
  assert.ok(versionRail.x >= versionCardBox.x + versionCardBox.width, 'version controls sit outside the right edge');
  assert.ok(versionRail.width <= 40, 'version rail renders as a narrow single-column rail');
  assert.ok(versionRail.y + versionRail.height <= versionCardBox.y + versionCardBox.height + 1, 'the version rail bottom stays within the card bottom');
  // The rail anchors to the top of its OWN page card (matching the drawing rail's anchor),
  // not to the vertically-centered content inside the card, so it stays put even in a
  // taller row. This still runs at 100% zoom (before the zoom-in below), so 3px is exact.
  assert.ok(Math.abs(versionRail.y - versionCardBox.y - 3) < 2, 'a single-column version rail sits ~3px below its own card top, not centered');
  const versionRailButtonXs = await page.locator('.variant-toolbar button').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  assert.ok(Math.max(...versionRailButtonXs) - Math.min(...versionRailButtonXs) < 1, 'version rail controls stack in a single column');
  await versionsPage.getByRole('button', { name: 'Next version' }).click();
  await page.waitForTimeout(50);
  assert.match(await versionsPage.locator('.variant-progress').innerText(), /2\/2/);
  const selectedVersion = versionsPage.locator('.variant-editor');
  await selectedVersion.click();
  await page.keyboard.type('Chosen draft');
  await versionsPage.getByRole('button', { name: 'Use selected version as text page' }).click();
  assert.equal((await versionsPage.locator('.text-block').innerText()).trim(), 'Chosen draft', 'selected version converts into a text page');

  const firstPage = page.locator('.page-card').first();
  const firstPageWrapper = page.locator('.page-wrapper').first();
  await firstPageWrapper.locator('.page-handle__notes').click();
  await page.waitForTimeout(80);
  assert.match((await firstPage.locator('.page-side-label').innerText()).trim(), /^notes$/i);
  await firstPageWrapper.locator('.page-handle__notes').click();

  const initialTheme = await page.locator('html').getAttribute('data-theme');
  await page.getByTitle(/Use (light|dark) mode/).click();
  const changedTheme = await page.locator('html').getAttribute('data-theme');
  assert.notEqual(changedTheme, initialTheme, 'theme toggle changes the applied theme');

  await page.getByTitle('Zoom in (Ctrl++)').click();
  assert.equal(await page.locator('.zoom-value').innerText(), '110%', 'zoom control updates the workspace scale');

  await page.locator('.page-insert__trigger').click();
  assert.equal(await page.getByRole('button', { name: /^Media/ }).count(), 1, 'image, video, and audio are grouped under Media');
  assert.equal(await page.getByRole('button', { name: /^(Image|Video|Audio)/ }).count(), 0, 'separate media entries are removed');
  await page.getByLabel('Choose media file').setInputFiles({ name: 'draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('unsupported') });
  assert.match(await page.getByRole('alertdialog').innerText(), /not a supported media format/i, 'unsupported media opens an error message');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByLabel('Choose media file').setInputFiles({
    name: 'sample.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')
  });
  await page.locator('.page-card').nth(2).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.page-card').count(), 3, 'supported media automatically creates a page');
  assert.equal(await page.locator('.page-card').last().locator('img').count(), 1, 'image format creates an image page');
  const imageCard = page.locator('.page-card').last();
  assert.equal(await imageCard.locator('.resize-handle').count(), 0, 'media pages drop the per-media resize line');
  const imageFillBox = await imageCard.locator('img').boundingBox();
  const imageCardBox = await imageCard.boundingBox();
  assert.ok(
    Math.abs(imageFillBox.x - imageCardBox.x) < 1 && Math.abs(imageFillBox.y - imageCardBox.y) < 1 &&
    Math.abs(imageFillBox.width - imageCardBox.width) < 1 && Math.abs(imageFillBox.height - imageCardBox.height) < 1,
    'media fills the whole page card with no surrounding dead space'
  );
  const imageRow = page.locator('.page-row').filter({ has: page.locator('img') }).last();
  const imageResizeBox = await imageRow.locator('.page-row-resize-handle').boundingBox();
  const imageResizeX = imageResizeBox.x + imageResizeBox.width / 2;
  const imageResizeY = imageResizeBox.y + imageResizeBox.height / 2;
  await dragPointer(imageResizeX, imageResizeY, imageResizeX, imageResizeY + 80);
  const imageHeightAfter = (await imageCard.boundingBox()).height;
  assert.ok(imageHeightAfter > imageCardBox.height + 40, `the shared row resize follows the cursor to grow the media page height (before ${imageCardBox.height.toFixed(2)}, after ${imageHeightAfter.toFixed(2)})`);
  assert.ok(Math.abs((await imageCard.locator('img').boundingBox()).height - imageHeightAfter) < 1, 'media keeps filling the page after the row resize');
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Drawing/ }).click();
  assert.equal(await page.locator('.page-card').count(), 4, 'adds a drawing page');
  const canvas = page.locator('.drawing-canvas').last();
  const box = await canvas.boundingBox();
  assert.ok(box, 'drawing canvas is visible');
  const drawingStartZoom = Number((await page.locator('.zoom-value').innerText()).replace('%', '')) / 100;
  assert.equal(Math.round(box.height / drawingStartZoom), 240, 'drawing pages start at their minimum layout height');
  const drawingCardBox = await page.locator('.page-card').last().boundingBox();
  const drawingRailBox = await page.locator('.drawing-toolbar').last().boundingBox();
  assert.equal(await page.locator('.page-card').last().locator('.page-side-label').count(), 0, 'drawing page has no title');
  assert.ok(Math.abs(box.x - drawingCardBox.x) < 1 && Math.abs(box.width - drawingCardBox.width) < 1, 'drawing canvas fills the page width');
  assert.ok(drawingRailBox.x > drawingCardBox.x + drawingCardBox.width, 'drawing controls sit on the right');
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 120);
  await page.mouse.up();
  const strokeUndo = page.getByRole('button', { name: 'Undo stroke' }).last();
  assert.equal(await strokeUndo.isEnabled(), true, 'drawing stroke persists in UI state');
  const strokeColor = async () => canvas.evaluate((element) => {
    const context = element.getContext('2d');
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0) return [pixels[index], pixels[index + 1], pixels[index + 2]];
    }
    return null;
  });
  const colorBeforeThemeChange = await strokeColor();
  assert.ok(colorBeforeThemeChange, 'the drawn stroke produces visible canvas pixels');
  await page.getByTitle(/Use (light|dark) mode/).click();
  await page.waitForTimeout(30);
  assert.notDeepEqual(await strokeColor(), colorBeforeThemeChange, 'existing drawing colors redraw immediately when the appearance mode changes');

  // Workspace zoom must not change a stroke's thickness relative to the drawing: draw a
  // purely horizontal stroke, measure its on-screen thickness with a coverage-sum scan
  // (summing the alpha channel down a column and dividing by 255 -- robust to
  // devicePixelRatio and to anti-aliasing, which a binary opaque-pixel count is not: a
  // binary count saturates to the same integer run for e.g. a 3px vs a 3.9px line because
  // anti-aliased edge pixels already cross the threshold at the smaller width), bump the
  // zoom one more step, force a redraw (data-theme and --editor-zoom are both watched by
  // the same MutationObserver), and confirm the SAME stroke's on-screen thickness scaled
  // with it instead of staying at its raw, unzoomed pixel width.
  const scanColumnThickness = async (xFraction) => canvas.evaluate((element, xFrac) => {
    const context = element.getContext('2d');
    const x = Math.min(element.width - 1, Math.max(0, Math.round(element.width * xFrac)));
    const column = context.getImageData(x, 0, 1, element.height).data;
    let coverage = 0;
    for (let y = 0; y < element.height; y++) coverage += column[y * 4 + 3];
    return coverage / 255;
  }, xFraction);
  const zoomStrokeBox = await canvas.boundingBox();
  const zoomStrokeY = zoomStrokeBox.y + zoomStrokeBox.height * 0.8;
  await page.mouse.move(zoomStrokeBox.x + zoomStrokeBox.width * 0.55, zoomStrokeY);
  await page.mouse.down();
  await page.mouse.move(zoomStrokeBox.x + zoomStrokeBox.width * 0.95, zoomStrokeY);
  await page.mouse.up();
  await page.waitForTimeout(30);
  const stableStrokeXFraction = 90 / box.width;
  const thicknessBeforeZoomBump = await scanColumnThickness(stableStrokeXFraction);
  const zoomBeforeBump = Number((await page.locator('.zoom-value').innerText()).replace('%', ''));
  await page.getByTitle('Zoom in (Ctrl++)').click();
  const zoomAfterBump = Number((await page.locator('.zoom-value').innerText()).replace('%', ''));
  assert.equal(zoomAfterBump, zoomBeforeBump + 10, 'zoom moved up one more step for the thickness check');
  await page.getByTitle(/Use (light|dark) mode/).click();
  await page.waitForTimeout(30);
  await page.getByTitle(/Use (light|dark) mode/).click();
  await page.waitForTimeout(30);
  const thicknessAfterZoomBump = await scanColumnThickness(stableStrokeXFraction);
  const thicknessRatio = thicknessAfterZoomBump / thicknessBeforeZoomBump;
  const expectedRatio = zoomAfterBump / zoomBeforeBump;
  assert.ok(Math.abs(thicknessRatio - expectedRatio) < 0.15, `stroke on-screen thickness should scale with zoom (~${expectedRatio.toFixed(3)}), got ${thicknessRatio.toFixed(3)} from ${thicknessBeforeZoomBump.toFixed(3)} to ${thicknessAfterZoomBump.toFixed(3)}`);
  await page.getByTitle('Zoom out (Ctrl+-)').click();
  assert.equal(await page.locator('.zoom-value').innerText(), `${zoomBeforeBump}%`, 'zoom restored for the remaining assertions');

  const drawingRow = page.locator('.page-row').filter({ has: page.locator('canvas') }).last();
  const resizeHandle = drawingRow.locator('.page-row-resize-handle');
  await resizeHandle.scrollIntoViewIfNeeded();
  const resizeBox = await resizeHandle.boundingBox();
  const initialCanvasHeight = (await canvas.boundingBox()).height;
  assert.ok(resizeBox, 'drawing resize handle is visible');
  const drawingResizeX = resizeBox.x + resizeBox.width / 2;
  const drawingResizeY = resizeBox.y + resizeBox.height / 2;
  await dragPointer(drawingResizeX, drawingResizeY, drawingResizeX, drawingResizeY + 90);
  assert.ok((await canvas.boundingBox()).height > initialCanvasHeight, 'drawing page resizes vertically');
  const documentWidthBeforeGrouping = (await page.locator('.page-row').first().boundingBox()).width;

  const dragPage = async (sourceHandle, targetWrapper, position) => {
    const sourceBox = await sourceHandle.boundingBox();
    const targetBox = await targetWrapper.boundingBox();
    assert.ok(sourceBox && targetBox, 'reorder controls are visible');
    const targetX = position === 'left' ? targetBox.x + 4 : position === 'right' ? targetBox.x + targetBox.width - 4 : targetBox.x + targetBox.width / 2;
    const targetY = position === 'before' ? targetBox.y + 4 : position === 'after' ? targetBox.y + targetBox.height - 4 : targetBox.y + targetBox.height / 2;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(30);
  };

  await dragPage(page.locator('.page-handle__drag').first(), page.locator('.page-wrapper').nth(1), 'right');
  assert.equal(await page.locator('.page-row--multi').first().locator('.page-row__cell').count(), 2, 'right-edge dragging joins two pages side by side');
  const textWrapper = page.locator('.page-wrapper').filter({ hasText: 'Cursor stays put' });
  const imageWrapper = page.locator('.page-wrapper').filter({ has: page.locator('img') });
  await dragPage(imageWrapper.locator('.page-handle__drag'), textWrapper, 'right');
  const drawingWrapper = page.locator('.page-wrapper').filter({ has: page.locator('canvas') });
  await dragPage(drawingWrapper.locator('.page-handle__drag'), imageWrapper, 'right');
  const groupedRow = page.locator('.page-row--multi').first();
  assert.equal(await groupedRow.locator('.page-row__cell').count(), 4, 'a row supports four side-by-side pages');
  assert.ok(Math.abs((await groupedRow.boundingBox()).width - documentWidthBeforeGrouping) < 1, 'grouping pages preserves the document width');
  const groupedCardBoxes = await groupedRow.locator('.page-card').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  assert.ok(Math.max(...groupedCardBoxes.map(({ width }) => width)) - Math.min(...groupedCardBoxes.map(({ width }) => width)) < 1, 'grouped pages divide into equal widths');
  assert.ok(Math.max(...groupedCardBoxes.map(({ height }) => height)) - Math.min(...groupedCardBoxes.map(({ height }) => height)) < 1, 'grouped pages match the tallest page height');
  const groupedSeparatorWidth = await page.locator('.page-row__cell').nth(1).evaluate((element) => parseFloat(getComputedStyle(element).borderLeftWidth));
  const groupedZoom = Number((await page.locator('.zoom-value').innerText()).replace('%', '')) / 100;
  assert.ok(Math.abs(groupedSeparatorWidth * groupedZoom - 1) < 0.05, 'side-by-side pages have a one-layout-pixel vertical separator');
  const groupedRowBox = await groupedRow.boundingBox();
  const groupedHandleBoxes = await groupedRow.locator('.page-handle').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, right: rect.right };
  }));
  assert.ok(groupedHandleBoxes.every(({ right }) => right <= groupedRowBox.x), 'all page handles stay outside the left edge');
  assert.deepEqual(groupedHandleBoxes.map(({ x }) => x), [...groupedHandleBoxes.map(({ x }) => x)].sort((a, b) => a - b), 'left handles follow page order');
  const drawingRailBoxAfterGrouping = await groupedRow.locator('.drawing-toolbar').boundingBox();
  assert.ok(drawingRailBoxAfterGrouping.x >= groupedRowBox.x + groupedRowBox.width, 'drawing controls stay outside the right edge after grouping');

  // Equal split is only the default: the vertical boundary between two grouped pages
  // can be dragged to change how they share the row width (still 110% zoom here).
  const columnHandle = groupedRow.locator('.page-column-resize-handle').first();
  const columnHandleBox = await columnHandle.boundingBox();
  assert.ok(columnHandleBox, 'grouped rows expose a vertical page-break handle');
  const rowWidthBeforeColumnDrag = (await groupedRow.boundingBox()).width;
  const leftPageWidthBefore = (await groupedRow.locator('.page-row__cell').first().boundingBox()).width;
  await page.mouse.move(columnHandleBox.x + columnHandleBox.width / 2, columnHandleBox.y + columnHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(columnHandleBox.x + columnHandleBox.width / 2 + 60, columnHandleBox.y + columnHandleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const leftPageWidthAfter = (await groupedRow.locator('.page-row__cell').first().boundingBox()).width;
  assert.ok(Math.abs((leftPageWidthAfter - leftPageWidthBefore) - 60) < 5, 'dragging the vertical boundary grows the left page one-to-one with the cursor');
  assert.ok(Math.abs((await groupedRow.boundingBox()).width - rowWidthBeforeColumnDrag) < 1, 'changing the page split preserves the total document width');
  const clampHandleBox = await groupedRow.locator('.page-column-resize-handle').first().boundingBox();
  await page.mouse.move(clampHandleBox.x + clampHandleBox.width / 2, clampHandleBox.y + clampHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(clampHandleBox.x + clampHandleBox.width / 2 - 900, clampHandleBox.y + clampHandleBox.height / 2, { steps: 10 });
  await page.mouse.up();
  const clampedPageWidths = await groupedRow.locator('.page-row__cell').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  assert.ok(Math.min(...clampedPageWidths) > 40, 'dragging far past the minimum clamps the split without collapsing a page');
  assert.ok(Math.abs((await groupedRow.boundingBox()).width - rowWidthBeforeColumnDrag) < 1, 'clamping the split still preserves the total document width');
  // Undo both boundary drags (each checkpoints at pointer-down) to restore the equal
  // split before the remaining assertions. Blur any editable so Ctrl+Z reaches the app.
  await page.evaluate(() => { const element = window.document.activeElement; if (element && element !== window.document.body && typeof element.blur === 'function') element.blur(); });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  const restoredCardBoxes = await groupedRow.locator('.page-card').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  assert.ok(Math.max(...restoredCardBoxes) - Math.min(...restoredCardBoxes) < 1, 'undo restores the equal split');

  const groupedHeightBeforeResize = (await groupedRow.boundingBox()).height;
  const groupedResizeBox = await groupedRow.locator('.page-row-resize-handle').boundingBox();
  const groupedResizeX = groupedResizeBox.x + groupedResizeBox.width / 2;
  const groupedResizeY = groupedResizeBox.y + groupedResizeBox.height / 2;
  await dragPointer(groupedResizeX, groupedResizeY, groupedResizeX, groupedResizeY + 260);
  const groupedHeightAfterExpand = (await groupedRow.boundingBox()).height;
  assert.ok(groupedHeightAfterExpand > groupedHeightBeforeResize, 'dragging the shared bottom expands the complete row');
  assert.ok(Math.abs((groupedHeightAfterExpand - groupedHeightBeforeResize) - 260) < 5, 'row expansion follows the cursor at one-to-one speed');
  const groupedShrinkBox = await groupedRow.locator('.page-row-resize-handle').boundingBox();
  const groupedShrinkX = groupedShrinkBox.x + groupedShrinkBox.width / 2;
  const groupedShrinkY = groupedShrinkBox.y + groupedShrinkBox.height / 2;
  await dragPointer(groupedShrinkX, groupedShrinkY, groupedShrinkX, groupedShrinkY - 120);
  const groupedHeightAfterShrink = (await groupedRow.boundingBox()).height;
  assert.ok(Math.abs((groupedHeightAfterExpand - groupedHeightAfterShrink) - 120) < 5, 'row shrinking follows the cursor at the same one-to-one speed');
  const groupedMinimumBox = await groupedRow.locator('.page-row-resize-handle').boundingBox();
  const groupedMinimumX = groupedMinimumBox.x + groupedMinimumBox.width / 2;
  const groupedMinimumY = groupedMinimumBox.y + groupedMinimumBox.height / 2;
  await dragPointer(groupedMinimumX, groupedMinimumY, groupedMinimumX, groupedMinimumY - 700);
  assert.ok((await groupedRow.boundingBox()).height < groupedHeightAfterShrink, 'the row continues shrinking until it reaches its content minimum');
  assert.equal(await textWrapper.locator('.page-card').evaluate((element) => element.scrollHeight <= element.clientHeight + 1), true, 'row shrinking never compacts existing text');

  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text/ }).click();
  assert.equal(await page.locator('.page-card').count(), 5, 'adds a fifth page in its own row');
  const stackBox = await page.locator('.page-stack').boundingBox();
  const boundaryBox = await page.locator('.page-boundary').boundingBox();
  assert.ok(Math.abs(stackBox.x - boundaryBox.x) < 1 && Math.abs(stackBox.width - boundaryBox.width) < 1, 'horizontal separators run through the full page stack');
  await dragPage(page.locator('.page-handle__drag').last(), drawingWrapper, 'right');
  assert.equal(await page.locator('.page-row--multi').first().locator('.page-row__cell').count(), 4, 'a full row rejects a fifth side-by-side page');
  assert.equal(await page.locator('.page-row').last().locator('.page-row__cell').count(), 1, 'rejected page remains in its original row');

  const verticalSourceBox = await page.locator('.page-handle__drag').last().boundingBox();
  const verticalTargetBox = await page.locator('.page-wrapper').first().boundingBox();
  await page.mouse.move(verticalSourceBox.x + verticalSourceBox.width / 2, verticalSourceBox.y + verticalSourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(verticalTargetBox.x + verticalTargetBox.width / 2, verticalTargetBox.y + 4, { steps: 12 });
  const highlightedRowBox = await page.locator('.page-row.drop-before').boundingBox();
  assert.ok(highlightedRowBox && Math.abs(highlightedRowBox.width - documentWidthBeforeGrouping) < 1, 'vertical drop highlighting spans the entire document width');
  assert.equal(await page.locator('.page-wrapper.drop-before').count(), 0, 'vertical drop highlighting is not limited to one page');
  await page.mouse.up();
  assert.equal(await page.locator('.page-row').first().locator('.page-row__cell').count(), 1, 'center-edge dragging still reorders rows vertically');
  await page.locator('.page-handle__delete').first().click();
  assert.equal(await page.locator('.page-card').count(), 4, 'page delete lives on the handle');

  // Column-resize rail stability. Rails and handles position from the row's constant
  // outer edges, so they must not move while a column boundary is dragged, and the
  // versions content-rail must rest just outside the row after an unequal split. Build a
  // fresh grouped row (the earlier versions page was converted to text): a versions page
  // (single-column 32px content rail), an image page, and a drawing page (full-width rail).
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Versions/ }).click();
  const railVersionsWrapper = page.locator('.page-wrapper').filter({ has: page.locator('.variant-block') }).last();
  await page.locator('.page-insert__trigger').click();
  await page.getByLabel('Choose media file').setInputFiles({
    name: 'rail.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="green"/></svg>')
  });
  await page.waitForTimeout(30);
  const railImageWrapper = page.locator('.page-wrapper').filter({ has: page.locator('img') }).last();
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Drawing/ }).click();
  const railDrawingWrapper = page.locator('.page-wrapper').filter({ has: page.locator('canvas') }).last();
  await dragPage(railImageWrapper.locator('.page-handle__drag'), railVersionsWrapper, 'right');
  await dragPage(railDrawingWrapper.locator('.page-handle__drag'), railImageWrapper, 'right');
  const railRow = page.locator('.page-row--multi').filter({ has: page.locator('.variant-block') }).filter({ has: page.locator('canvas') }).last();
  assert.equal(await railRow.locator('.page-row__cell').count(), 3, 'built a versions/image/drawing grouped row');

  // Right rails anchor to the top of their own page card, not to the row's vertically-
  // centered content: the image page opens at its 420px default block height, so this row
  // is well past the versions page's own natural minimum -- exactly the "taller row"
  // scenario that used to leave the versions rail floating mid-card. --editor-zoom is
  // still active here (a CSS `zoom` on .page-stack), so normalize the measured offset by
  // the current zoom factor before comparing it to the unzoomed 3px anchor from app.css.
  const railRowHeightForOffsetCheck = (await railRow.boundingBox()).height;
  assert.ok(railRowHeightForOffsetCheck > 300, 'grouped row is meaningfully taller than the versions page content, reproducing the floating-rail scenario');
  const railZoomFactor = Number((await page.locator('.zoom-value').innerText()).replace('%', '')) / 100;
  const railVersionsCardBox = await railRow.locator('.page-row__cell').filter({ has: page.locator('.variant-block') }).locator('.page-card').boundingBox();
  const railDrawingCardBoxForOffset = await railRow.locator('.page-row__cell').filter({ has: page.locator('canvas') }).locator('.page-card').boundingBox();
  const railVersionsRailBoxForOffset = await railRow.locator('.variant-toolbar').boundingBox();
  const railDrawingRailBoxForOffset = await railRow.locator('.drawing-toolbar').boundingBox();
  const railVersionsTopOffset = railVersionsRailBoxForOffset.y - railVersionsCardBox.y;
  const railDrawingTopOffset = railDrawingRailBoxForOffset.y - railDrawingCardBoxForOffset.y;
  assert.ok(Math.abs(railVersionsTopOffset / railZoomFactor - 3) < 3, `the versions rail sits ~3px below its own card top in a taller grouped row, not centered (got ${(railVersionsTopOffset / railZoomFactor).toFixed(2)}px unzoomed)`);
  assert.ok(Math.abs(railVersionsTopOffset - railDrawingTopOffset) < 2, 'the versions rail top matches the drawing rail top in the same row');

  const railGeometry = async () => {
    const handles = await railRow.locator('.page-handle').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    const versionRail = await railRow.locator('.variant-toolbar').boundingBox();
    const drawingRail = await railRow.locator('.drawing-toolbar').boundingBox();
    const imageBox = await railRow.locator('img').boundingBox();
    const imageCellWidth = await railRow.locator('.page-row__cell').filter({ has: page.locator('img') }).evaluate((element) => element.getBoundingClientRect().width);
    return { handles, versionRailX: versionRail.x, drawingRailX: drawingRail.x, imageWidth: imageBox.width, imageCellWidth };
  };

  const railBefore = await railGeometry();
  // (a) Drag the versions|image boundary right, shrinking the image cell, and record the
  // in-flight geometry before releasing. Incremental moves because Edge under-reports a
  // single large mouse move.
  const railHandleBox = await railRow.locator('.page-column-resize-handle').first().boundingBox();
  const railStartX = railHandleBox.x + railHandleBox.width / 2;
  const railY = railHandleBox.y + railHandleBox.height / 2;
  await page.mouse.move(railStartX, railY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(railStartX + (70 * step) / 8, railY);
  const railDuring = await railGeometry();
  // (b) During the in-flight drag every handle and rail stays within ~2px of its start.
  railBefore.handles.forEach((x, index) => assert.ok(Math.abs(x - railDuring.handles[index]) <= 2, 'left handles stay pinned to the row edge during a column drag'));
  assert.ok(Math.abs(railBefore.versionRailX - railDuring.versionRailX) <= 2, 'the versions rail stays fixed during a column drag');
  assert.ok(Math.abs(railBefore.drawingRailX - railDuring.drawingRailX) <= 2, 'the drawing rail stays fixed during a column drag');
  // (d) The grouped image tracks its (shrinking) cell width mid-drag.
  assert.ok(Math.abs(railDuring.imageWidth - railDuring.imageCellWidth) <= 2, 'the grouped image tracks its cell width during the drag');
  await page.mouse.up();
  await page.waitForTimeout(40);

  const railAfter = await railGeometry();
  const railRowAfterBox = await railRow.boundingBox();
  const railRowRight = railRowAfterBox.x + railRowAfterBox.width;
  // (c) After release handles/rails are unchanged and rails sit just outside the row's
  // right edge in page order (versions content-rail nearest, drawing full-rail beyond it).
  railBefore.handles.forEach((x, index) => assert.ok(Math.abs(x - railAfter.handles[index]) <= 2, 'left handles return to the row edge after a column drag'));
  assert.ok(railAfter.versionRailX >= railRowRight && railAfter.versionRailX - railRowRight < 20, 'the versions rail rests just outside the row right edge after an unequal split');
  assert.ok(railAfter.drawingRailX > railAfter.versionRailX, 'right rails stay ordered by page after an unequal split');
  assert.ok(Math.abs(railAfter.imageWidth - railAfter.imageCellWidth) <= 2, 'the grouped image still fills its cell after the drag');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('button[title="Save (Ctrl+S)"]').click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, 'save creates a downloadable .folio file');
  assert.match(download.suggestedFilename(), /\.folio$/);

  // Persisted stroke widths stay in raw layout px: every stroke above was drawn at 110%
  // (or briefly 120%) workspace zoom, but the archived manifest must still record the
  // untouched slider value (3), not a zoom-multiplied one.
  const savedManifest = JSON.parse(await (await JSZip.loadAsync(await readFile(path))).file('manifest.json').async('string'));
  const persistedStrokeWidths = Object.values(savedManifest.pages || {})
    .filter((savedPage) => savedPage.type === 'drawing')
    .flatMap((savedPage) => (savedPage.drawing?.strokes ?? []).map((stroke) => stroke.width));
  assert.ok(persistedStrokeWidths.length >= 2, 'expected the strokes drawn earlier on the drawing page to be persisted');
  assert.ok(persistedStrokeWidths.every((width) => width === 3), `persisted stroke widths remain zoom-invariant layout px (slider default 3), got ${JSON.stringify(persistedStrokeWidths)}`);

  const homeChangedViewNextFrame = await page.getByRole('button', { name: 'Back to folios' }).evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return Boolean(document.querySelector('.library'));
  });
  assert.ok(homeChangedViewNextFrame, 'returning home changes view by the next animation frame');
  await page.locator('.folio-card').waitFor({ state: 'visible' });
  assert.match(await page.locator('.folio-card').first().innerText(), /Untitled Folio/i, 'the edited folio returns to the home library');
  await page.screenshot({ path: 'folio-preview.png', fullPage: true });
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join('\n')}`);
  console.log('Browser interaction smoke test passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => smokeServer.close(resolve));
}
