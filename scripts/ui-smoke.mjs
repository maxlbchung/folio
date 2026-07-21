import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';

const [script, styles, logo] = await Promise.all([
  readFile(new URL('../dist-smoke-current/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist-smoke-current/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/inktile-logo.png', import.meta.url))
]);

const smokeServer = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/migration-seed') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body></body></html>');
    return;
  }
  if (request.url === '/framed-deny') {
    // Refuses embedding like most large sites do — exercises the link popup's
    // no-preview path (Chromium renders its error page in the frame instead).
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('X-Frame-Options', 'DENY');
    response.end('<!doctype html><html><body>no framing</body></html>');
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
  if (request.url === '/inktile-logo.png' || request.url === '/favicon.ico') {
    response.setHeader('Content-Type', 'image/png');
    response.end(logo);
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
      const request = indexedDB.deleteDatabase('inktile-editor');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('inktile-editor', 2);
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
  const inktileLogo = page.locator('.inktile-wordmark img[src="./inktile-logo.png"]');
  await inktileLogo.waitFor({ state: 'visible' });
  assert.equal(await inktileLogo.evaluate((image) => image.complete && image.naturalWidth > 0), true, 'Inktile wordmark logo loads');
  await page.getByLabel('Delete Version two fixture').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inktile-card[data-inktile-id]').count(), 1, 'database version 3 migrates version 2 library metadata into the lightweight index');
  await page.getByLabel('Delete Version two fixture').click();
  await page.getByRole('button', { name: 'Delete inktile' }).click();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inktile-card[data-inktile-id]').count(), 0, 'starts on an empty inktile library');
  assert.equal(await page.getByRole('button', { name: 'Create your first inktile' }).count(), 1, 'the empty home page offers a create action');
  assert.equal(await page.getByRole('button', { name: /^Open .inktile/ }).count(), 1, 'home page offers an existing inktile import action');
  assert.equal(await page.getByRole('button', { name: 'Settings' }).count(), 1, 'home page offers application settings');
  assert.ok(
    (await page.locator('html').evaluate((root) => getComputedStyle(root).getPropertyValue('--cursor-default'))).includes('%231d1d1b'),
    'light mode uses the black custom cursor family'
  );
  assert.equal(
    await page.locator('html').evaluate((root) => getComputedStyle(root).scrollbarWidth),
    'none',
    'home hides the native scrollbar so the shared overlay workspace scrollbar owns library scrolling'
  );

  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.getByRole('radio', { name: 'Dark' }).check();
  await settingsDialog.getByLabel('UI scale').selectOption('1.1');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'home settings apply the selected theme');
  assert.ok(
    (await page.locator('html').evaluate((root) => getComputedStyle(root).getPropertyValue('--cursor-default'))).includes('%23fff'),
    'dark mode uses the white custom cursor family'
  );
  assert.equal(await page.locator('html').evaluate((root) => root.style.getPropertyValue('--ui-scale')), '1.1', 'home settings apply the selected UI scale');
  const scaledLayout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const library = document.querySelector('.library').getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      shellLeft: shell.left,
      shellRight: shell.right,
      libraryCenter: (library.left + library.right) / 2,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
  assert.ok(
    Math.abs(scaledLayout.shellLeft) <= 1 && Math.abs(scaledLayout.shellRight - scaledLayout.viewport) <= 1,
    `UI scale keeps the shell filling the viewport width, got ${scaledLayout.shellLeft}..${scaledLayout.shellRight} of ${scaledLayout.viewport}`
  );
  assert.ok(
    Math.abs(scaledLayout.libraryCenter - scaledLayout.viewport / 2) <= 2,
    `UI scale keeps Home horizontally centered, got center ${scaledLayout.libraryCenter} of ${scaledLayout.viewport}`
  );
  assert.equal(scaledLayout.scrollWidth, scaledLayout.clientWidth, 'UI scale introduces no horizontal overflow');
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await page.locator('.library').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Dark' }).isChecked(), true, 'theme persists across a full reload');
  assert.equal(await page.getByRole('dialog', { name: 'Settings' }).getByLabel('UI scale').inputValue(), '1.1', 'UI scale persists across a full reload');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Light' }).check();
  await page.getByRole('dialog', { name: 'Settings' }).getByLabel('UI scale').selectOption('1');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close settings' }).click();

  // Create two real local-library entries so title lookup, full-text frequency,
  // rename, reopen, ordering, and deletion are exercised before the editor suite.
  await page.getByRole('button', { name: 'Create your first inktile' }).click();
  await page.locator('.page-insert__trigger').waitFor({ state: 'visible' });
  await page.locator('.document-title').fill('Research notes');
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text Write/ }).click();
  await page.locator('.text-block').click();
  await page.keyboard.type('signal signal signal');
  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.getByRole('button', { name: /^New inktile/ }).click();
  await page.locator('.document-title').fill('Signal brief');
  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.locator('.inktile-card[data-inktile-id]').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inktile-card[data-inktile-id]').count(), 2, 'new inktiles persist on the home page');
  assert.deepEqual(
    await page.getByLabel('View inktiles by').locator('option').allTextContents(),
    ['Last opened', 'Date created', 'Last edited'],
    'library exposes the date-based view modes without a title mode'
  );

  await page.getByPlaceholder('Look up titles and text').fill('signal');
  const lookupResults = page.getByRole('region', { name: 'Matches' });
  assert.equal(await lookupResults.locator('.inktile-card[data-inktile-id]').count(), 2, 'title and text lookup matches share one result group');
  assert.match(await lookupResults.locator('.inktile-card[data-inktile-id]').first().innerText(), /Signal brief/i, 'lookup initially follows the last-opened view mode');
  assert.match(await lookupResults.locator('.inktile-card[data-inktile-id]').filter({ hasText: 'Research notes' }).innerText(), /3 matches/i, 'text lookup still exposes occurrence counts');
  await page.getByLabel('View inktiles by').selectOption('createdAt');
  await page.getByRole('button', { name: 'Sort ascending' }).click();
  assert.equal(await page.getByRole('button', { name: 'Sort descending' }).count(), 1, 'library switches between descending and ascending');
  assert.match(await lookupResults.locator('.inktile-card[data-inktile-id]').first().innerText(), /Research notes/i, 'keyword lookup reorders with the selected view mode and direction');
  await page.getByRole('button', { name: 'Clear search' }).click();

  await page.getByLabel('Edit title for Signal brief').click();
  await page.getByLabel('Inktile title', { exact: true }).fill('Beacon brief');
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByText('Title updated').waitFor({ state: 'visible' });
  await page.reload();
  await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Open Research notes' }).click();
  assert.equal((await page.locator('.text-block').innerText()).trim(), 'signal signal signal', 'a persisted library inktile reopens after a full reload');
  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
  const cachedLibraryOpenChangedViewNextFrame = await page.getByRole('button', { name: 'Open Research notes' }).evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return Boolean(document.querySelector('.page-stack'));
  });
  assert.ok(cachedLibraryOpenChangedViewNextFrame, 'a cached library snapshot reopens by the next animation frame');
  assert.equal((await page.locator('.text-block').innerText()).trim(), 'signal signal signal', 'a library inktile reopens for editing with its text intact');

  const cleanCycleDurations = [];
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Back to inktiles' }).click();
    await page.getByRole('button', { name: 'Open Research notes' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Open Research notes' }).click();
    await page.locator('.text-block').waitFor({ state: 'visible' });
    cleanCycleDurations.push(Date.now() - startedAt);
  }
  assert.ok(
    cleanCycleDurations.every((duration) => duration < 750),
    `six clean Home/Open cycles stay responsive without accumulating work, got ${JSON.stringify(cleanCycleDurations)}ms`
  );
  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.getByLabel('Delete Beacon brief').waitFor({ state: 'visible' });
  await page.getByLabel('Delete Beacon brief').click();
  await page.getByRole('button', { name: 'Delete inktile' }).click();
  await page.getByLabel('Delete Research notes').waitFor({ state: 'visible' });
  await page.getByLabel('Delete Research notes').click();
  await page.getByRole('button', { name: 'Delete inktile' }).click();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inktile-card[data-inktile-id]').count(), 0, 'inktile deletion removes local-library entries');
  await page.reload();
  await page.getByText('The shelf is empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inktile-card[data-inktile-id]').count(), 0, 'a deleted autosaved inktile stays deleted after restart');

  await page.getByRole('button', { name: 'Create your first inktile' }).click();
  await page.locator('.page-insert__trigger').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.page-card').count(), 0, 'starts without prepopulated pages');

  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text Write/ }).click();
  assert.equal(await page.locator('.page-card').count(), 1, 'adds a text page');
  const textCardSpacing = await page.locator('.page-card').first().evaluate((element) => {
    // Padding lives on the face (page front / notes back share one card), not the card.
    const style = getComputedStyle(element.querySelector('.page-face--front'));
    return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom), height: element.getBoundingClientRect().height };
  });
  assert.equal(textCardSpacing.top, textCardSpacing.bottom, 'text page top and bottom spacing match');
  assert.ok(textCardSpacing.bottom <= 17, 'text page vertical spacing is halved');
  assert.ok(textCardSpacing.height >= 90 && textCardSpacing.height < 100, 'text page minimum height fits the vertical page rail');
  assert.equal(
    await page.locator('.page-card').first().evaluate((element) => getComputedStyle(element.querySelector('.page-face--front')).justifyContent),
    'flex-start',
    'new tiles anchor text to the top by default'
  );

  const titleBox = await page.locator('.document-title').boundingBox();
  const formattingBox = await page.locator('.text-toolbar').boundingBox();
  assert.ok(titleBox.x < 40, 'document title hugs the left side');
  assert.ok(formattingBox.y < 45, 'text formatting sits in the top header row');
  assert.equal(await page.getByLabel('Font family').inputValue(), 'Inter', 'font defaults to Inter (bundled) without a placeholder option');
  assert.equal(await page.getByLabel('Font size').inputValue(), '3', 'font size defaults to Normal without a placeholder option');

  const text = page.locator('.text-block').first();
  await text.click();
  await page.keyboard.type('Cursor stays put');
  assert.equal((await text.innerText()).trim(), 'Cursor stays put', 'typing preserves the caret position');

  await page.keyboard.press('Control+A');
  await page.getByRole('button', { name: 'Bold' }).click();
  assert.match(await text.innerHTML(), /font-weight|<b|<strong/i, 'header formatting applies to selected text');
  assert.equal(
    await page.getByRole('button', { name: 'Bold' }).evaluate((button) => button.classList.contains('is-active')),
    true,
    'the Bold control shows an active state while the selection is bold'
  );
  // Collapsed-caret toggle must update the control immediately, before any typing. The pending
  // typing style a browser sets for an empty selection is not reported by queryCommandState, so
  // toggling bold off with the caret parked in bold text has to flip the button right away.
  const boldButton = page.getByRole('button', { name: 'Bold' });
  const boldActive = () => boldButton.evaluate((button) => button.classList.contains('is-active'));
  await page.keyboard.press('End');
  assert.equal(await boldActive(), true, 'the Bold control stays active with the caret collapsed inside bold text');
  await boldButton.click();
  // Re-check after the browser's asynchronous selectionchange has had a chance to fire: the
  // toggle must stay reflected, not revert once the deferred selection sync runs.
  await page.waitForTimeout(80);
  assert.equal(await boldActive(), false, 'toggling bold off stays reflected at a collapsed caret, before any typing');
  await boldButton.click();
  await page.waitForTimeout(80);
  assert.equal(await boldActive(), true, 'toggling bold back on stays reflected at a collapsed caret');
  // The Ctrl+B/I/U shortcuts must drive the toolbar through the same path as the buttons, not
  // the browser's native handler, so the highlight tracks a collapsed-caret toggle instead of
  // lagging until the next keystroke.
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(80);
  assert.equal(await boldActive(), false, 'the Ctrl+B shortcut updates the Bold control immediately at a collapsed caret');
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(80);
  assert.equal(await boldActive(), true, 'the Ctrl+B shortcut toggles the Bold control back immediately at a collapsed caret');
  // Vertical anchoring lives in the header's More-formatting dropdown.
  await page.getByRole('button', { name: 'More formatting' }).click();
  await page.getByRole('menuitem', { name: 'Anchor text to bottom' }).click();
  assert.equal(await page.locator('.page-card').first().evaluate((element) => getComputedStyle(element.querySelector('.page-face--front')).justifyContent), 'flex-end', 'text supports page-level vertical anchoring');

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
  await versionsPage.getByRole('button', { name: 'Use selected version as text tile' }).click();
  assert.equal((await versionsPage.locator('.text-block').innerText()).trim(), 'Chosen draft', 'selected version converts into a text page');

  const firstPage = page.locator('.page-card').first();
  const firstPageWrapper = page.locator('.page-wrapper').first();
  await firstPageWrapper.locator('.page-handle__notes').click();
  await page.waitForTimeout(80);
  assert.match((await firstPage.locator('.page-side-label').innerText()).trim(), /^notes$/i);
  // The card is sized by the FRONT face alone: notes taller than the front never grow the
  // tile — they scroll inside it (hidden native bar, shared overlay scrollbar).
  const frontDefinedHeight = (await firstPage.boundingBox()).height;
  assert.equal(await firstPageWrapper.locator('.notes-scrollbar').count(), 0, 'short notes render no overlay scrollbar');
  await firstPage.locator('.page-face--back .text-block').click();
  for (let noteLine = 0; noteLine < 18; noteLine += 1) {
    await page.keyboard.type(`note line ${noteLine + 1}`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(120);
  assert.ok(Math.abs((await firstPage.boundingBox()).height - frontDefinedHeight) < 1, 'notes taller than the front do not change the card height');
  const notesOverflow = await firstPage.locator('.page-face--back .page-blocks').evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.ok(notesOverflow.scrollHeight > notesOverflow.clientHeight + 10, 'overflowing notes scroll inside the tile instead of growing it');
  assert.equal(await firstPageWrapper.locator('.notes-scrollbar').count(), 1, 'overflowing notes render the overlay scrollbar');
  // Clear the notes again so the rest of the suite sees the document it expects.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
  await firstPageWrapper.locator('.page-handle__notes').click();

  assert.equal(await page.getByTitle(/Use (light|dark) mode/).count(), 0, 'theme control is removed from the editor toolbar');

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
  assert.equal(await page.locator('.page-card').last().locator('.page-face--front .page-side-label').count(), 0, 'drawing page front has no title');
  assert.ok(Math.abs(box.x - drawingCardBox.x) < 1 && Math.abs(box.width - drawingCardBox.width) < 1, 'drawing canvas fills the page width');
  assert.ok(drawingRailBox.x > drawingCardBox.x + drawingCardBox.width, 'drawing controls sit on the right');
  const brushCursor = page.locator('.drawing-brush-cursor').last();
  const brushCircle = brushCursor.locator('.drawing-brush-cursor__circle');
  const renderedDrawingScale = box.width / await canvas.evaluate((element) => element.offsetWidth);
  await page.mouse.move(box.x + 30, box.y + 30);
  assert.ok(
    Math.abs((await brushCircle.boundingBox()).width - 3 * renderedDrawingScale) < 0.2,
    'drawing cursor circle matches the pen stroke diameter after UI scale'
  );
  const drawingWidth = page.getByLabel('Stroke width').last();
  await drawingWidth.fill('10');
  await page.getByRole('button', { name: 'Eraser' }).last().click();
  await page.mouse.move(box.x + 31, box.y + 31);
  assert.ok(
    Math.abs((await brushCircle.boundingBox()).width - 20 * renderedDrawingScale) < 0.2,
    'eraser cursor circle matches its doubled stroke diameter without counting the prongs'
  );
  await page.getByRole('button', { name: 'Pen' }).last().click();
  await drawingWidth.fill('3');
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
  const themeBeforeRedrawCheck = await page.locator('html').getAttribute('data-theme');
  await page.locator('html').evaluate((root) => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; });
  await page.waitForTimeout(30);
  assert.notDeepEqual(await strokeColor(), colorBeforeThemeChange, 'existing drawing colors redraw immediately when the appearance mode changes');
  await page.locator('html').evaluate((root, theme) => { root.dataset.theme = theme; }, themeBeforeRedrawCheck);

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
  const cursorDiameterBeforeZoomBump = (await brushCircle.boundingBox()).width;
  const zoomBeforeBump = Number((await page.locator('.zoom-value').innerText()).replace('%', ''));
  await page.getByTitle('Zoom in (Ctrl++)').click();
  const zoomAfterBump = Number((await page.locator('.zoom-value').innerText()).replace('%', ''));
  assert.equal(zoomAfterBump, zoomBeforeBump + 10, 'zoom moved up one more step for the thickness check');
  await page.waitForTimeout(60);
  const thicknessAfterZoomBump = await scanColumnThickness(stableStrokeXFraction);
  const cursorDiameterAfterZoomBump = (await brushCircle.boundingBox()).width;
  const thicknessRatio = thicknessAfterZoomBump / thicknessBeforeZoomBump;
  const expectedRatio = zoomAfterBump / zoomBeforeBump;
  assert.ok(Math.abs(thicknessRatio - expectedRatio) < 0.15, `stroke on-screen thickness should scale with zoom (~${expectedRatio.toFixed(3)}), got ${thicknessRatio.toFixed(3)} from ${thicknessBeforeZoomBump.toFixed(3)} to ${thicknessAfterZoomBump.toFixed(3)}`);
  assert.ok(Math.abs(cursorDiameterAfterZoomBump / cursorDiameterBeforeZoomBump - expectedRatio) < 0.03, 'drawing cursor circle scales with workspace zoom by the same ratio as the stroke');
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
  // Undo both boundary drags (each checkpoints on its first pointer movement) to restore
  // the equal split before the remaining assertions. Blur any editable so Ctrl+Z reaches the app.
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
  await page.getByRole('button', { name: /^Text Write/ }).click();
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

  // The Ctrl+S flush must confirm the local-library snapshot without creating any file;
  // the explicit Export action is the only browser gesture that produces a download.
  let browserSaveDownloads = 0;
  const countBrowserSaveDownload = () => { browserSaveDownloads += 1; };
  page.on('download', countBrowserSaveDownload);
  await page.keyboard.press('Control+S');
  await page.getByText('Saved', { exact: true }).waitFor({ state: 'visible' });
  page.off('download', countBrowserSaveDownload);
  assert.equal(browserSaveDownloads, 0, 'the browser Ctrl+S flush updates the local library without creating a file');

  // The Export button opens a format picker; the .inktile option produces the same
  // downloadable archive the button used to create directly.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('button[title="Export…"]').click();
  await page.locator('.export-option', { hasText: 'Inktile file' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, 'export creates a downloadable .inktile file');
  assert.match(download.suggestedFilename(), /\.inktile$/);
  await page.locator('.export-option').first().waitFor({ state: 'detached' });

  // The text option downloads a .txt holding the document's text with markup stripped.
  const textDownloadPromise = page.waitForEvent('download');
  await page.locator('button[title="Export…"]').click();
  await page.locator('.export-option', { hasText: 'Text file' }).click();
  const textDownload = await textDownloadPromise;
  assert.match(textDownload.suggestedFilename(), /\.txt$/);
  const exportedText = await readFile(await textDownload.path(), 'utf8');
  assert.ok(exportedText.trim().length > 0, 'text export is not empty');
  assert.ok(!/<[a-z][^>]*>/i.test(exportedText), 'text export contains no HTML markup');

  // Persisted stroke widths stay in raw layout px: every stroke above was drawn at 110%
  // (or briefly 120%) workspace zoom, but the archived manifest must still record the
  // untouched slider value (3), not a zoom-multiplied one.
  const savedManifest = JSON.parse(await (await JSZip.loadAsync(await readFile(path))).file('manifest.json').async('string'));
  const persistedStrokeWidths = Object.values(savedManifest.pages || {})
    .filter((savedPage) => savedPage.type === 'drawing')
    .flatMap((savedPage) => (savedPage.drawing?.strokes ?? []).map((stroke) => stroke.width));
  assert.ok(persistedStrokeWidths.length >= 2, 'expected the strokes drawn earlier on the drawing page to be persisted');
  assert.ok(persistedStrokeWidths.every((width) => width === 3), `persisted stroke widths remain zoom-invariant layout px (slider default 3), got ${JSON.stringify(persistedStrokeWidths)}`);

  // Exercise native path semantics with a small Tauri IPC mock. An externally opened
  // inktile must overwrite its known path, while a library-only inktile must stay inside
  // the local library until Save As explicitly chooses a destination.
  const nativeArchiveBytes = Array.from(await readFile(path));
  const nativePath = 'C:\\Inktiles\\existing.inktile';
  const saveAsPath = 'C:\\Inktiles\\explicit-copy.inktile';
  const nativeContext = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await nativeContext.addInitScript(({ archiveBytes, openPath, chosenPath, metadataImage }) => {
    window.__inktileNativeMock = {
      archiveBytes,
      openPath,
      chosenPath,
      metadataImage,
      saveDialogCalls: 0,
      pendingWritePath: null,
      writePaths: []
    };
    // The event plugin's unlisten path goes through this second global.
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      // getCurrentWindow()/getCurrentWebview() read these labels synchronously; without
      // them the Home drag-drop listener throws before it can register.
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main', windowLabel: 'main' }
      },
      // The event system registers listener callbacks through these two hooks.
      transformCallback: (() => { let next = 1; return () => next++; })(),
      unregisterCallback: () => {},
      invoke: async (command, args, options) => {
        const mock = window.__inktileNativeMock;
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return null;
        if (command === 'plugin:dialog|open') return mock.openPath;
        if (command === 'plugin:dialog|save') {
          mock.saveDialogCalls += 1;
          return mock.chosenPath;
        }
        if (command === 'plugin:fs|read_file') return mock.archiveBytes;
        if (command === 'save_file_atomic') {
          // Native document writes go through the app's own atomic command (bytes as the
          // raw payload, target path percent-encoded in a header); the temp-then-rename
          // dance lives in Rust now, so the mock records the confirmed destination only.
          const target = decodeURIComponent(options?.headers?.['x-inktile-path'] ?? '');
          if (!target) throw new Error('save_file_atomic was invoked without a target path header');
          mock.writePaths.push(target);
          return null;
        }
        if (command === 'fetch_link_metadata') {
          // The desktop shell's Open Graph unfurler for the link popup's card.
          return { title: 'Example Domain', description: 'A test destination for unfurled previews.', image: mock.metadataImage };
        }
        throw new Error(`Unexpected native mock command: ${command}`);
      }
    };
  }, { archiveBytes: nativeArchiveBytes, openPath: nativePath, chosenPath: saveAsPath, metadataImage: `${smokeUrl}inktile-logo.png` });

  try {
    const nativePage = await nativeContext.newPage();
    const nativeConsoleErrors = [];
    nativePage.on('console', (message) => {
      if (message.type() === 'error') nativeConsoleErrors.push(message.text());
    });
    nativePage.on('pageerror', (error) => nativeConsoleErrors.push(error.message));
    await nativePage.goto(smokeUrl);
    await nativePage.locator('.library').waitFor({ state: 'visible' });
    await nativePage.getByRole('button', { name: /^Open .inktile/ }).click();
    await nativePage.locator('.page-stack').waitFor({ state: 'visible' });

    await nativePage.keyboard.press('Control+S');
    await nativePage.waitForFunction(() => window.__inktileNativeMock.writePaths.length === 1, undefined, { timeout: 10_000 });
    let nativeState = await nativePage.evaluate(() => ({
      saveDialogCalls: window.__inktileNativeMock.saveDialogCalls,
      writePaths: [...window.__inktileNativeMock.writePaths]
    }));
    assert.equal(nativeState.saveDialogCalls, 0, 'native Save does not open a destination dialog for an external inktile');
    assert.deepEqual(nativeState.writePaths, [nativePath], 'native Save overwrites the path returned by Open');

    await nativePage.getByRole('button', { name: 'Back to inktiles' }).click();
    await nativePage.locator('.inktile-card__open').waitFor({ state: 'visible' });
    await nativePage.locator('.inktile-card__open').click();
    await nativePage.locator('.page-stack').waitFor({ state: 'visible' });
    await nativePage.keyboard.press('Control+S');
    await nativePage.waitForFunction(() => window.__inktileNativeMock.writePaths.length === 2, undefined, { timeout: 10_000 });
    nativeState = await nativePage.evaluate(() => ({
      saveDialogCalls: window.__inktileNativeMock.saveDialogCalls,
      writePaths: [...window.__inktileNativeMock.writePaths]
    }));
    assert.equal(nativeState.saveDialogCalls, 0, 'reopening the imported inktile from the library retains its native path');
    assert.deepEqual(nativeState.writePaths, [nativePath, nativePath], 'the reopened inktile still overwrites its original file');

    // Editing alone must reach the external file through the debounced autosave —
    // no Ctrl+S, no destination dialog.
    await nativePage.locator('.document-title').fill('Native autosave');
    await nativePage.waitForFunction(() => window.__inktileNativeMock.writePaths.length === 3, undefined, { timeout: 10_000 });
    nativeState = await nativePage.evaluate(() => ({
      saveDialogCalls: window.__inktileNativeMock.saveDialogCalls,
      writePaths: [...window.__inktileNativeMock.writePaths]
    }));
    assert.equal(nativeState.saveDialogCalls, 0, 'autosave never opens a destination dialog');
    assert.deepEqual(nativeState.writePaths, [nativePath, nativePath, nativePath], 'editing autosaves over the known native path without Ctrl+S');

    // New inktile is a home-only action now, so make one from the library, not the editor.
    await nativePage.getByRole('button', { name: 'Back to inktiles' }).click();
    await nativePage.getByRole('button', { name: /^New inktile/ }).click();
    await nativePage.locator('.page-insert__trigger').waitFor({ state: 'visible' });
    await nativePage.keyboard.press('Control+S');
    await nativePage.getByText('Saved', { exact: true }).waitFor({ state: 'visible' });
    nativeState = await nativePage.evaluate(() => ({
      saveDialogCalls: window.__inktileNativeMock.saveDialogCalls,
      writePaths: [...window.__inktileNativeMock.writePaths]
    }));
    assert.equal(nativeState.saveDialogCalls, 0, 'normal Save keeps a library-only inktile in the local library');
    assert.deepEqual(nativeState.writePaths, [nativePath, nativePath, nativePath], 'normal Save does not create an external file for a library-only inktile');

    await nativePage.keyboard.press('Control+Shift+S');
    await nativePage.waitForFunction(() => window.__inktileNativeMock.writePaths.length === 4, undefined, { timeout: 10_000 });
    nativeState = await nativePage.evaluate(() => ({
      saveDialogCalls: window.__inktileNativeMock.saveDialogCalls,
      writePaths: [...window.__inktileNativeMock.writePaths]
    }));
    assert.equal(nativeState.saveDialogCalls, 1, 'Save As explicitly opens the destination dialog');
    assert.equal(nativeState.writePaths.at(-1), saveAsPath, 'Save As writes the chosen destination');

    // Desktop link unfurling: the popup asks the shell for Open Graph metadata and
    // renders the page's own card (image, title, description) instead of the live embed.
    await nativePage.locator('.page-insert__trigger').click();
    await nativePage.getByRole('button', { name: /^Text Write/ }).click();
    const nativeText = nativePage.locator('.text-block').first();
    await nativeText.click();
    await nativePage.keyboard.type('see https://example.com/card ');
    await nativeText.locator('a[href="https://example.com/card"]').click();
    await nativePage.locator('.link-preview').waitFor({ state: 'visible' });
    await nativePage.locator('.link-preview__card').waitFor({ state: 'visible' });
    assert.equal(await nativePage.locator('.link-preview__card-title').innerText(), 'Example Domain', 'the desktop popup renders the unfurled page title');
    assert.match(await nativePage.locator('.link-preview__card-desc').innerText(), /test destination/, 'the desktop popup renders the unfurled description');
    assert.equal(await nativePage.locator('.link-preview__card img').count(), 1, 'the desktop popup renders the og:image');
    assert.equal(await nativePage.locator('.link-preview__frame').count(), 0, 'the live embed stays unmounted when a metadata card is shown');
    await nativePage.keyboard.press('Escape');
    await nativePage.locator('.link-preview').waitFor({ state: 'detached' });

    assert.deepEqual(nativeConsoleErrors, [], `native mock console errors: ${nativeConsoleErrors.join('\n')}`);
  } finally {
    await nativeContext.close();
  }

  // Tile multi-selection: Ctrl+A selects every tile, Ctrl+Click on handles toggles tiles
  // into a multi-selection, and the selection supports duplicate/copy/paste/flip/delete
  // shortcuts, a group right-click menu, and group dragging.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const element = window.document.activeElement;
    if (element && element !== window.document.body && typeof element.blur === 'function') element.blur();
  });
  const tileCountBeforeSelection = await page.locator('.page-wrapper').count();
  await page.keyboard.press('Control+a');
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), tileCountBeforeSelection, 'Ctrl+A selects every tile');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 0, 'Escape clears the tile selection');

  const ctrlClickHandle = async (wrapper) => {
    await wrapper.scrollIntoViewIfNeeded();
    const handleBox = await wrapper.locator('.page-handle__drag').boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.click(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.keyboard.up('Control');
  };
  await ctrlClickHandle(page.locator('.page-wrapper').first());
  await ctrlClickHandle(page.locator('.page-wrapper').last());
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 2, 'Ctrl+Click on handles builds a multi-selection');
  assert.equal(
    await page.locator('.page-wrapper.is-selected').first().locator('.page-handle').evaluate((element) => getComputedStyle(element).outlineStyle),
    'solid',
    'a selected tile outlines its left handle as well as its card'
  );

  await page.keyboard.press('Control+d');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeSelection + 2, 'Ctrl+D duplicates every selected tile');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeSelection, 'Delete removes the (duplicated) selection');

  await ctrlClickHandle(page.locator('.page-wrapper').first());
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeSelection + 1, 'Ctrl+C / Ctrl+V pastes a copy of the selected tile');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeSelection, 'the pasted tile is selected and deletes cleanly');

  const firstSelectableWrapper = page.locator('.page-wrapper').first();
  await ctrlClickHandle(firstSelectableWrapper);
  await ctrlClickHandle(page.locator('.page-wrapper').last());
  const menuHandleBox = await firstSelectableWrapper.locator('.page-handle__drag').boundingBox();
  await page.mouse.click(menuHandleBox.x + 2, menuHandleBox.y + 2, { button: 'right' });
  await page.locator('.home-menu').waitFor({ state: 'visible' });
  assert.match(await page.locator('.home-menu__title').innerText(), /2 tiles selected/i, 'right-clicking a selected tile opens the multi-tile menu');
  await page.getByRole('menuitem', { name: 'Flip 2 tiles' }).click();
  await page.waitForTimeout(120);
  assert.equal(await firstSelectableWrapper.locator('.page-card').evaluate((element) => element.classList.contains('is-flipped')), true, 'the menu flips the first selected tile to notes');
  assert.equal(await page.locator('.page-wrapper').last().locator('.page-card').evaluate((element) => element.classList.contains('is-flipped')), true, 'the menu flips the last selected tile to notes');
  await page.keyboard.press('f');
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.page-card.is-flipped').count(), 0, 'the F shortcut flips the selection back to the front');

  // Multi-tile formatting: with tiles selected, toolbar formatting commands apply to every
  // selected tile's whole text as one undo step. "Cursor stays put" is bold from the
  // earlier toolbar test and "Chosen draft" is not — a mixed selection, so the first
  // Ctrl+B must make BOTH fully bold instead of toggling each tile independently into
  // the opposite mix.
  await page.keyboard.press('Escape');
  const boldTextWrapper = page.locator('.page-wrapper').filter({ hasText: 'Cursor stays put' }).first();
  const plainTextWrapper = page.locator('.page-wrapper').filter({ hasText: 'Chosen draft' }).first();
  await ctrlClickHandle(boldTextWrapper);
  await ctrlClickHandle(plainTextWrapper);
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 2, 'two text tiles are selected for the formatting checks');
  const boldPattern = /font-weight:\s*(bold|[6-9]00)|<b[\s>]|<strong/i;
  const underlinePattern = /text-decoration[^;"]*underline|<u[\s>]/i;
  const boldTileHtml = () => boldTextWrapper.locator('.page-face--front .text-block').innerHTML();
  const plainTileHtml = () => plainTextWrapper.locator('.page-face--front .text-block').innerHTML();
  assert.match(await boldTileHtml(), boldPattern, 'precondition: the first selected tile is bold from the earlier test');
  assert.doesNotMatch(await plainTileHtml(), boldPattern, 'precondition: the second selected tile is not bold');
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(80);
  assert.match(await boldTileHtml(), boldPattern, 'Ctrl+B on a mixed selection keeps the bold tile bold');
  assert.match(await plainTileHtml(), boldPattern, 'Ctrl+B on a mixed selection bolds the plain tile');
  await page.getByRole('button', { name: 'Underline' }).click();
  await page.waitForTimeout(80);
  assert.match(await boldTileHtml(), underlinePattern, 'the Underline button applies to the first selected tile');
  assert.match(await plainTileHtml(), underlinePattern, 'the Underline button applies to the second selected tile');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);
  assert.doesNotMatch(await boldTileHtml(), underlinePattern, 'one undo reverts the whole multi-tile underline');
  assert.doesNotMatch(await plainTileHtml(), underlinePattern, 'one undo reverts the underline on the second tile too');
  assert.match(await plainTileHtml(), boldPattern, 'undoing the underline keeps the earlier multi-tile bold');
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(80);
  assert.doesNotMatch(await boldTileHtml(), boldPattern, 'Ctrl+B on an all-bold selection unbolds the first tile');
  assert.doesNotMatch(await plainTileHtml(), boldPattern, 'Ctrl+B on an all-bold selection unbolds the second tile');
  await page.keyboard.press('Escape');

  // Audio tiles center their player bar vertically in the tile.
  const wavBytes = (() => {
    const dataLength = 3200;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataLength, 4); buffer.write('WAVE', 8);
    buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36); buffer.writeUInt32LE(dataLength, 40);
    return buffer;
  })();
  const tileCountBeforeAudio = await page.locator('.page-wrapper').count();
  await page.getByLabel('Choose media file').setInputFiles({ name: 'ping.wav', mimeType: 'audio/wav', buffer: wavBytes });
  await page.waitForFunction((expected) => window.document.querySelectorAll('.page-wrapper').length === expected, tileCountBeforeAudio + 1);
  const audioWrapper = page.locator('.page-wrapper').last();
  assert.equal(await audioWrapper.locator('audio').count(), 1, 'the audio tile renders a player');
  const audioFace = audioWrapper.locator('.page-face--front');
  assert.equal(await audioFace.evaluate((element) => element.classList.contains('page-face--audio')), true, 'an audio tile tags its front face');
  assert.equal(await audioFace.evaluate((element) => getComputedStyle(element).justifyContent), 'center', 'the audio player is vertically centered in its tile');
  await audioWrapper.scrollIntoViewIfNeeded();
  const audioHandleBox = await audioWrapper.locator('.page-handle__drag').boundingBox();
  await page.mouse.click(audioHandleBox.x + audioHandleBox.width / 2, audioHandleBox.y + audioHandleBox.height / 2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeAudio, 'the audio tile deletes cleanly');

  // Group dragging: the last two tiles share the bottom row, so dragging one of their
  // selected handles above the top row must carry both, still grouped side by side.
  await page.keyboard.press('Escape');
  const tileIdsBeforeGroupDrag = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  const groupDragIds = tileIdsBeforeGroupDrag.slice(-2);
  await ctrlClickHandle(page.locator('.page-wrapper').nth(tileCountBeforeSelection - 2));
  await ctrlClickHandle(page.locator('.page-wrapper').last());
  const groupDragHandleBox = await page.locator('.page-wrapper').nth(tileCountBeforeSelection - 2).locator('.page-handle__drag').boundingBox();
  const groupDropBox = await page.locator('.page-wrapper').first().boundingBox();
  await page.mouse.move(groupDragHandleBox.x + groupDragHandleBox.width / 2, groupDragHandleBox.y + groupDragHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(groupDropBox.x + groupDropBox.width / 2, groupDropBox.y + 4, { steps: 12 });
  assert.equal(await page.locator('.page-wrapper.is-dragging').count(), 2, 'both selected tiles render as dragging during a group drag');
  await page.mouse.up();
  await page.waitForTimeout(40);
  const tileIdsAfterGroupDrag = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  assert.deepEqual(tileIdsAfterGroupDrag.slice(0, 2), groupDragIds, 'dragging a selected handle moves the whole selection before the drop row');
  const groupDragRowSize = await page.locator('.page-row').first().locator('.page-row__cell').count();
  assert.equal(groupDragRowSize, 2, 'tiles selected from one row stay grouped in one row after a group drag');

  // A plain handle click (press and release without movement) collapses the selection to
  // just that tile, releasing the rest of the group.
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 2, 'the moved group stays selected after the drop');
  const collapseHandleBox = await page.locator('.page-wrapper').first().locator('.page-handle__drag').boundingBox();
  await page.mouse.click(collapseHandleBox.x + collapseHandleBox.width / 2, collapseHandleBox.y + collapseHandleBox.height / 2);
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 1, 'a plain handle click selects only that tile');
  assert.equal(await page.locator('.page-wrapper.is-selected').first().evaluate((element) => element.dataset.pageId), groupDragIds[0], 'the clicked tile is the one that stays selected');

  await page.mouse.click(groupDropBox.x + groupDropBox.width / 2, groupDropBox.y + groupDropBox.height / 2);
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 0, 'a plain click away from the handles clears the tile selection');

  // Edge selection: a plain click on a row's bottom edge strip selects that edge as an
  // insertion point (mutually exclusive with tile selection); Ctrl+V pastes there, and
  // right-clicking an edge offers adding or pasting at that exact spot.
  const firstRowStrip = page.locator('.page-row').first().locator('.page-row-resize-handle');
  const stripBox = await firstRowStrip.boundingBox();
  await page.mouse.click(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
  assert.equal(await page.locator('.page-edge-selection').count(), 1, 'clicking a row edge selects it as an insertion point');
  assert.equal(await page.locator('.page-wrapper.is-selected').count(), 0, 'edge selection and tile selection stay mutually exclusive');
  const idsBeforeEdgePaste = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(40);
  const idsAfterEdgePaste = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  assert.equal(idsAfterEdgePaste.length, idsBeforeEdgePaste.length + 1, 'Ctrl+V pastes at the selected edge');
  assert.deepEqual(idsAfterEdgePaste.slice(0, 2), idsBeforeEdgePaste.slice(0, 2), 'tiles above the selected edge stay put');
  assert.deepEqual(idsAfterEdgePaste.slice(3), idsBeforeEdgePaste.slice(2), 'the pasted tile lands exactly at the selected edge');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);

  const edgeMenuStripBox = await page.locator('.page-row').first().locator('.page-row-resize-handle').boundingBox();
  await page.mouse.click(edgeMenuStripBox.x + edgeMenuStripBox.width / 2, edgeMenuStripBox.y + edgeMenuStripBox.height / 2, { button: 'right' });
  await page.locator('.home-menu').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('menuitem', { name: /^Add/ }).count(), 4, 'the edge menu offers every tile type');
  await page.getByRole('menuitem', { name: 'Add text' }).click();
  await page.waitForTimeout(40);
  const idsAfterEdgeAdd = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  assert.equal(idsAfterEdgeAdd.length, idsBeforeEdgePaste.length + 1, 'right-clicking an edge offers adding a tile at that spot');
  assert.deepEqual(idsAfterEdgeAdd.slice(3), idsBeforeEdgePaste.slice(2), 'the added tile lands at the right-clicked edge');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), idsBeforeEdgePaste.length, 'edge insertions clean up for the remaining assertions');

  // The very top of the document is a selectable edge too: pasting there puts the
  // tile above the first row.
  const topStripBox = await page.locator('.page-row-top-edge').boundingBox();
  await page.mouse.click(topStripBox.x + topStripBox.width / 2, topStripBox.y + topStripBox.height / 2);
  assert.equal(await page.locator('.page-edge-selection--top').count(), 1, 'clicking above the first row selects the top edge');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(40);
  const idsAfterTopPaste = await page.locator('.page-wrapper').evaluateAll((elements) => elements.map((element) => element.dataset.pageId));
  assert.equal(idsAfterTopPaste.length, idsBeforeEdgePaste.length + 1, 'Ctrl+V pastes at the top edge');
  assert.deepEqual(idsAfterTopPaste.slice(1), idsBeforeEdgePaste, 'the pasted tile lands above the first row');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);

  // Vertical boundaries between grouped tiles are selectable edges as well: pasting
  // inserts into the row at that column, respecting the four-per-row maximum.
  const pairRow = page.locator('.page-row').first();
  const pairHandleBox = await pairRow.locator('.page-column-resize-handle').first().boundingBox();
  await page.mouse.click(pairHandleBox.x + pairHandleBox.width / 2, pairHandleBox.y + pairHandleBox.height / 2);
  assert.equal(await page.locator('.page-edge-selection--column').count(), 1, 'clicking the boundary between grouped tiles selects that vertical edge');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(40);
  assert.equal(await pairRow.locator('.page-row__cell').count(), 3, 'Ctrl+V pastes into the row at the selected vertical edge');
  const middleCellId = await pairRow.locator('.page-row__cell').nth(1).locator('[data-page-id]').evaluate((element) => element.dataset.pageId);
  assert.ok(!idsBeforeEdgePaste.includes(middleCellId), 'the pasted tile sits between the two grouped tiles');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await pairRow.locator('.page-row__cell').count(), 2, 'deleting the pasted tile restores the grouped pair');

  const pairMenuHandleBox = await pairRow.locator('.page-column-resize-handle').first().boundingBox();
  await page.mouse.click(pairMenuHandleBox.x + pairMenuHandleBox.width / 2, pairMenuHandleBox.y + pairMenuHandleBox.height / 2, { button: 'right' });
  await page.locator('.home-menu').waitFor({ state: 'visible' });
  await page.getByRole('menuitem', { name: 'Add drawing' }).click();
  await page.waitForTimeout(40);
  assert.equal(await pairRow.locator('.page-row__cell').count(), 3, 'the vertical edge menu adds a tile between the grouped tiles');
  assert.equal(await pairRow.locator('.page-row__cell').nth(1).locator('canvas').count(), 1, 'the edge menu creates the chosen tile type (drawing)');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), idsBeforeEdgePaste.length, 'vertical edge insertions clean up for the remaining assertions');

  // The document's outer left and right edges are vertical edges too: they insert at
  // the start or the end of that row.
  const leftStripBox = await pairRow.locator('.page-row-side-edge--left').boundingBox();
  await page.mouse.click(leftStripBox.x + leftStripBox.width / 2, leftStripBox.y + leftStripBox.height / 2);
  assert.equal(await page.locator('.page-edge-selection--column').count(), 1, 'clicking the document left edge selects a vertical edge');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(40);
  assert.equal(await pairRow.locator('.page-row__cell').count(), 3, 'Ctrl+V pastes at the start of the row from the left edge');
  const firstCellId = await pairRow.locator('.page-row__cell').first().locator('[data-page-id]').evaluate((element) => element.dataset.pageId);
  assert.ok(!idsBeforeEdgePaste.includes(firstCellId), 'the pasted tile becomes the first tile of the row');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);

  const rightStripBox = await pairRow.locator('.page-row-side-edge--right').boundingBox();
  await page.mouse.click(rightStripBox.x + rightStripBox.width / 2, rightStripBox.y + rightStripBox.height / 2, { button: 'right' });
  await page.locator('.home-menu').waitFor({ state: 'visible' });
  await page.getByRole('menuitem', { name: 'Add versions' }).click();
  await page.waitForTimeout(40);
  assert.equal(await pairRow.locator('.page-row__cell').count(), 3, 'the right edge menu adds a tile at the end of the row');
  const lastCellId = await pairRow.locator('.page-row__cell').last().locator('[data-page-id]').evaluate((element) => element.dataset.pageId);
  assert.ok(!idsBeforeEdgePaste.includes(lastCellId), 'the added tile becomes the last tile of the row');
  assert.equal(await pairRow.locator('.variant-block').count(), 1, 'the edge menu creates the chosen tile type (versions)');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), idsBeforeEdgePaste.length, 'side edge insertions clean up for the remaining assertions');

  // The tile menu offers the same four types; media routes through the file picker and
  // lands right below the clicked tile.
  const menuTileBox = await page.locator('.page-wrapper').first().locator('.page-card').boundingBox();
  await page.mouse.click(menuTileBox.x + menuTileBox.width / 2, menuTileBox.y + 6, { button: 'right' });
  await page.locator('.home-menu').waitFor({ state: 'visible' });
  const tileCountBeforeMenuMedia = await page.locator('.page-wrapper').count();
  const menuMediaChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add media' }).click();
  const menuMediaChooser = await menuMediaChooserPromise;
  await menuMediaChooser.setFiles({ name: 'menu-ping.wav', mimeType: 'audio/wav', buffer: wavBytes });
  await page.waitForFunction((expected) => window.document.querySelectorAll('.page-wrapper').length === expected, tileCountBeforeMenuMedia + 1);
  const menuAudioWrapper = page.locator('.page-wrapper').filter({ has: page.locator('audio') }).first();
  assert.equal(await menuAudioWrapper.locator('audio').count(), 1, 'the context menu adds media tiles through the file picker');
  await menuAudioWrapper.scrollIntoViewIfNeeded();
  const menuAudioHandleBox = await menuAudioWrapper.locator('.page-handle__drag').boundingBox();
  await page.mouse.click(menuAudioHandleBox.x + menuAudioHandleBox.width / 2, menuAudioHandleBox.y + menuAudioHandleBox.height / 2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), tileCountBeforeMenuMedia, 'the menu-added media tile cleans up');

  // Edge strips only light up while the cursor is over the strip itself: hovering a
  // tile must not bold the row edge below it or the vertical edge beside it.
  const rowStripSpanOpacity = () => pairRow.locator('.page-row-resize-handle span').evaluate((element) => getComputedStyle(element).opacity);
  const columnStripSpanOpacity = () => pairRow.locator('.page-column-resize-handle span').first().evaluate((element) => getComputedStyle(element).opacity);
  const hoverCardBox = await pairRow.locator('.page-card').first().boundingBox();
  await page.mouse.move(hoverCardBox.x + hoverCardBox.width / 2, hoverCardBox.y + hoverCardBox.height / 2);
  await page.waitForTimeout(250);
  assert.equal(await rowStripSpanOpacity(), '0', 'hovering a tile does not bold the row edge strip');
  assert.equal(await columnStripSpanOpacity(), '0', 'hovering a tile does not bold the vertical edge strip');
  const hoverStripBox = await pairRow.locator('.page-row-resize-handle').boundingBox();
  await page.mouse.move(hoverStripBox.x + hoverStripBox.width / 2, hoverStripBox.y + hoverStripBox.height / 2);
  await page.waitForTimeout(250);
  assert.ok(Number(await rowStripSpanOpacity()) > 0.5, 'hovering an edge strip itself bolds that strip');
  assert.equal(await columnStripSpanOpacity(), '0', 'hovering one edge strip leaves the other edges unbolded');

  // In a plain browser (no desktop shell, no mock injected yet), the Inkjet
  // panel announces itself as desktop-only: one note, no connect attempt, no
  // retry button or provider details.
  await page.getByRole('button', { name: 'Inkjet panel' }).click();
  await page.locator('.inkjet-setup__note').waitFor({ state: 'visible' });
  assert.match(await page.locator('.inkjet-setup').innerText(), /desktop-only/i, 'the browser build announces Inkjet as desktop-only');
  assert.equal(await page.locator('.inkjet-setup button').count(), 0, 'the desktop-only note stands alone — no retry or other controls');
  await page.getByRole('button', { name: 'Inkjet panel' }).click();

  // Agent turn: a mocked broker transport (mirroring the Tauri IPC mock) drives the real
  // panel, connection, op application, and turn lock. Covers: read-only lock while a turn
  // runs, live op streaming into the document, the revision guard rejecting stale writes,
  // one-undo-per-turn semantics, and the stop button keeping partial work.
  await page.evaluate(() => {
    const state = { receive: null, log: { staleRejected: false, stopRequested: false, error: null, opFailure: null, model: null, imageSizing: null, strokeOps: null, strokeSummary: null, clampedHeight: null, narrowRejected: false } };
    window.__inktileAgentMockState = state;
    const waiters = [];
    const results = [];
    const nextResult = () => new Promise((resolve) => {
      if (results.length) resolve(results.shift());
      else waiters.push(resolve);
    });
    let callCounter = 0;
    const sendOp = async (op) => {
      state.receive(JSON.stringify({ type: 'op', callId: `mock-call-${callCounter++}`, op }));
      return nextResult();
    };
    // A tiny but valid mono 16-bit WAV, so the audio pipeline is exercised with
    // bytes the browser can genuinely decode.
    const wavBase64 = (() => {
      const bytes = new Uint8Array(60);
      const view = new DataView(bytes.buffer);
      const ascii = (offset, text) => { for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index); };
      ascii(0, 'RIFF'); view.setUint32(4, 52, true); ascii(8, 'WAVE');
      ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, 'data'); view.setUint32(40, 16, true);
      for (let index = 0; index < 8; index += 1) view.setInt16(44 + index * 2, Math.round(Math.sin(index / 2) * 8000), true);
      return btoa(String.fromCharCode(...bytes));
    })();
    const runScriptedTurn = async (prompt) => {
      state.receive(JSON.stringify({ type: 'turn-start', promptId: prompt.promptId }));
      // In-progress process notes ride the ephemeral thinking channel; only the
      // final answer (sent at the end of the turn) persists in the transcript.
      state.receive(JSON.stringify({ type: 'thinking', promptId: prompt.promptId, text: 'Planning a short report page…' }));
      const read = await sendOp({ kind: 'read_document' });
      let revision = read.result.revision;
      const lastPageId = read.result.document.pageRows.flat().at(-1);
      // A write computed against a stale revision must bounce off the guard.
      const stale = await sendOp({ kind: 'append_text', pageId: lastPageId, html: 'x', baseRevision: revision - 1 });
      state.log.staleRejected = stale.ok === false && stale.code === 'revision';
      // Every op below must succeed; mustOk threads the revision and records failures.
      const mustOk = async (op) => {
        const outcome = await sendOp({ ...op, baseRevision: revision });
        if (!outcome.ok) state.log.opFailure = `${op.kind}: ${outcome.error}`;
        else revision = outcome.result.revision;
        return outcome.result ?? {};
      };
      const inserted = await mustOk({ kind: 'insert_page', afterPageId: lastPageId, html: '<p>Agent report:</p>' });
      const pageId = inserted.pageId;
      for (const word of ['The', ' agent', ' streamed', ' this', ' sentence', ' word', ' by', ' word.']) {
        await mustOk({ kind: 'append_text', pageId, html: word });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      // Full-control surface: rename, versions lifecycle, drawing, audio,
      // resize, notes, deletion — all inside the same single-undo turn.
      await mustOk({ kind: 'set_title', title: 'Inkjet Report' });
      const versions = await mustOk({ kind: 'insert_versions', afterPageId: pageId, variants: [{ label: 'A', html: '<p>Draft A</p>' }, { label: 'B', html: '<p>Draft B</p>' }], activeIndex: 0 });
      await mustOk({ kind: 'edit_versions', pageId: versions.pageId, activeIndex: 1 });
      const drawing = await mustOk({ kind: 'create_drawing', afterPageId: versions.pageId, height: 260, strokes: [{ tool: 'pen', width: 4, points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.4 }, { x: 0.8, y: 0.8 }] }] });
      await mustOk({ kind: 'edit_drawing', pageId: drawing.pageId, strokes: [{ tool: 'highlighter', points: [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.9 }] }], mode: 'append' });
      // Stroke-level control: full read, restyle + translate by id, precise delete.
      const drawingRead = await mustOk({ kind: 'read_drawing', pageId: drawing.pageId });
      const strokeIds = drawingRead.drawing.strokes.map((stroke) => stroke.id);
      await mustOk({ kind: 'modify_strokes', pageId: drawing.pageId, strokeIds: [strokeIds[0]], dx: 0.1, dy: -0.05, tool: 'highlighter', width: 8 });
      await mustOk({ kind: 'delete_strokes', pageId: drawing.pageId, strokeIds: [strokeIds[1]] });
      const drawingAfter = await mustOk({ kind: 'read_drawing', pageId: drawing.pageId });
      state.log.strokeOps = {
        beforeCount: drawingRead.drawing.strokes.length,
        beforeFirst: drawingRead.drawing.strokes[0],
        canvas: { widthPx: drawingRead.drawing.widthPx, height: drawingRead.drawing.height },
        afterCount: drawingAfter.drawing.strokes.length,
        afterFirst: drawingAfter.drawing.strokes[0]
      };
      // Range enforcement: a drawing row cannot store less than its 240px floor;
      // the op clamps and reports the applied height.
      const clamped = await mustOk({ kind: 'set_row_height', pageId: drawing.pageId, height: 96 });
      state.log.clampedHeight = clamped.height;
      await mustOk({ kind: 'insert_media', afterPageId: drawing.pageId, filename: 'ping.wav', mimeType: 'audio/wav', alt: 'test tone', bytesBase64: wavBase64 });
      // A 2:1 SVG: its row must auto-size to the aspect ratio, and read_document
      // must report the pixel geometry (pageWidth, widthPx, intrinsic size).
      const svgBase64 = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#3a6"/></svg>');
      const image = await mustOk({ kind: 'insert_media', afterPageId: drawing.pageId, filename: 'wide.svg', mimeType: 'image/svg+xml', alt: 'wide banner', bytesBase64: svgBase64 });
      const reread = await mustOk({ kind: 'read_document' });
      const imagePage = reread.document.pages.find((candidate) => candidate.id === image.pageId);
      state.log.imageSizing = imagePage ? {
        pageWidth: reread.document.pageWidth,
        widthPx: imagePage.widthPx,
        height: imagePage.height,
        asset: `${imagePage.asset?.width}x${imagePage.asset?.height}`
      } : null;
      const drawingPage = reread.document.pages.find((candidate) => candidate.id === drawing.pageId);
      state.log.strokeSummary = drawingPage?.drawing?.strokes?.[0] ?? null;
      await mustOk({ kind: 'set_row_height', pageId, height: 300 });
      await mustOk({ kind: 'edit_notes', pageId, html: '<p>note from inkjet</p>' });
      // Width splits reject columns narrower than the app's 120px drag floor.
      await mustOk({ kind: 'arrange_pages', pageId: versions.pageId, targetPageId: pageId, position: 'right' });
      const tooNarrow = await sendOp({ kind: 'set_row_widths', pageId, fractions: [0.05, 0.95], baseRevision: revision });
      state.log.narrowRejected = tooNarrow.ok === false && /at least/.test(tooNarrow.error || '');
      await mustOk({ kind: 'set_row_widths', pageId, fractions: [0.3, 0.7] });
      await mustOk({ kind: 'delete_pages', pageIds: [versions.pageId, image.pageId] });
      state.receive(JSON.stringify({ type: 'answer', promptId: prompt.promptId, text: 'Wrote a **short report** into a new page…\n\n- reading the document\n- streaming the text' }));
      state.receive(JSON.stringify({ type: 'turn-end', promptId: prompt.promptId, reason: 'done' }));
    };
    const runSlowTurn = async (prompt) => {
      state.receive(JSON.stringify({ type: 'turn-start', promptId: prompt.promptId }));
      // Ephemeral reasoning: with no answer to supersede it, this thinking
      // bubble persists through the whole turn and is dropped only at turn-end.
      state.receive(JSON.stringify({ type: 'thinking', promptId: prompt.promptId, text: 'Planning the slow drip, one word at a time…' }));
      const read = await sendOp({ kind: 'read_document' });
      let revision = read.result.revision;
      const inserted = await sendOp({ kind: 'insert_page', afterPageId: read.result.document.pageRows.flat().at(-1), baseRevision: revision });
      const pageId = inserted.result.pageId;
      revision = inserted.result.revision;
      for (let index = 0; index < 200 && !state.log.stopRequested; index += 1) {
        const appended = await sendOp({ kind: 'append_text', pageId, html: ' drip', baseRevision: revision });
        if (!appended.ok) break;
        revision = appended.result.revision;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      state.receive(JSON.stringify({ type: 'turn-end', promptId: prompt.promptId, reason: 'stopped' }));
    };
    window.__inktileAgentMock = {
      connect(receive, closed) {
        state.receive = receive;
        return {
          send(data) {
            const message = JSON.parse(data);
            if (message.type === 'probe') {
              // Availability drives the provider screen: only Claude is "installed".
              state.receive(JSON.stringify({
                type: 'status',
                backends: {
                  claude: { available: true, detail: 'Using your existing Claude Code login.', models: [{ id: '', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }] },
                  codex: { available: false, detail: 'The codex CLI was not found.', models: [] },
                  opencode: { available: false, detail: 'The opencode CLI was not found.', models: [] }
                }
              }));
            } else if (message.type === 'tool-result') {
              const waiter = waiters.shift();
              if (waiter) waiter(message);
              else results.push(message);
            } else if (message.type === 'prompt') {
              state.log.model = message.model ?? null;
              const run = message.prompt.startsWith('slow') ? runSlowTurn : runScriptedTurn;
              run(message).catch((error) => {
                state.log.error = String(error);
                state.receive(JSON.stringify({ type: 'turn-end', promptId: message.promptId, reason: 'error', error: String(error) }));
              });
            } else if (message.type === 'stop') {
              state.log.stopRequested = true;
            }
          },
          close() { closed(); }
        };
      }
    };
  });

  // Opening the panel is all it takes: the app starts the (mocked) broker itself,
  // detects which providers are installed and signed in, and offers only those.
  await page.getByRole('button', { name: 'Inkjet panel' }).click();
  await page.getByRole('button', { name: 'Start session' }).waitFor({ state: 'visible' });
  assert.match(await page.locator('.inkjet-setup__intro').innerText(), /built-in AI agent/i, 'the setup screen introduces Inkjet above the provider list');
  assert.equal(await page.locator('.inkjet-setup__providers label').count(), 3, 'every provider is listed, available or not');
  assert.equal(await page.locator('.inkjet-setup__providers input:disabled').count(), 2, 'unavailable providers are disabled');
  assert.ok(
    Number(await page.locator('.inkjet-setup__providers label.is-unavailable').first().evaluate((element) => getComputedStyle(element).opacity)) < 0.6,
    'unavailable providers render greyed out'
  );
  assert.match(await page.locator('.inkjet-setup__providers label:not(.is-unavailable)').innerText(), /Claude/, 'the available provider stays enabled');
  assert.equal(await page.locator('.inkjet-setup__providers input:not(:disabled)').isChecked(), true, 'the single available provider is preselected');
  await page.getByLabel('Inkjet model').selectOption('sonnet');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByLabel('Inkjet prompt').waitFor({ state: 'visible' });
  assert.match(await page.locator('.inkjet-panel__session').innerText(), /Claude · Sonnet/i, 'the chat header shows the session provider and model');

  // The panel edge drags to resize (persisted); at 100% UI scale the pointer maps 1:1.
  const panelBoxBefore = await page.locator('.inkjet-panel').boundingBox();
  const resizeStrip = await page.locator('.inkjet-panel__resize').boundingBox();
  await dragPointer(resizeStrip.x + 4, resizeStrip.y + resizeStrip.height / 2, resizeStrip.x + 4 - 120, resizeStrip.y + resizeStrip.height / 2);
  const panelBoxAfter = await page.locator('.inkjet-panel').boundingBox();
  assert.ok(
    Math.abs((panelBoxAfter.width - panelBoxBefore.width) - 120) < 6,
    `dragging the edge widens the panel one-to-one (${panelBoxBefore.width.toFixed(1)} -> ${panelBoxAfter.width.toFixed(1)})`
  );

  // The composer grows with its content; the manual resize grip is gone.
  const composer = page.getByLabel('Inkjet prompt');
  assert.equal(await composer.evaluate((element) => getComputedStyle(element).resize), 'none', 'the composer has no manual resize grip');
  const composerHeightBefore = (await composer.boundingBox()).height;
  await composer.fill('one\ntwo\nthree\nfour\nfive');
  const composerHeightTall = (await composer.boundingBox()).height;
  assert.ok(composerHeightTall > composerHeightBefore + 20, `the composer grows to fit its text (${composerHeightBefore} -> ${composerHeightTall})`);
  await composer.fill('');
  assert.ok((await composer.boundingBox()).height <= composerHeightBefore + 1, 'clearing the prompt shrinks the composer back');

  const pagesBeforeAgentTurn = await page.locator('.page-wrapper').count();
  const drawingsBeforeAgentTurn = await page.locator('.page-card--drawing').count();
  const versionsBeforeAgentTurn = await page.locator('.variant-block').count();
  const titleBeforeAgentTurn = await page.locator('.document-title').inputValue();
  assert.equal(await page.locator('.text-block').first().getAttribute('contenteditable'), 'true', 'text blocks are editable before an agent turn');
  await page.getByLabel('Inkjet prompt').fill('Write a short report');
  await page.keyboard.press('Enter');
  await page.locator('.workspace--agent-locked').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inkjet-turn-indicator').count(), 1, 'an Inkjet turn shows the printing indicator with its stop button');
  assert.match(await page.locator('.inkjet-turn-indicator').innerText(), /printing/i, 'the turn indicator reads "Inkjet is printing"');
  assert.equal(await page.locator('.inkjet-lock-scrim').count(), 1, 'a full-viewport scrim locks everything except the Inkjet surfaces during a turn');
  // Follow mode: the indicator's toggle arms viewport tracking of the agent's
  // work; a manual wheel gesture over the document hands control back.
  const followButton = page.locator('.inkjet-turn-indicator__follow');
  assert.equal(await followButton.getAttribute('aria-pressed'), 'false', 'the follow toggle starts disarmed');
  await followButton.click();
  assert.equal(await followButton.getAttribute('aria-pressed'), 'true', 'clicking the follow toggle arms it');
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() =>
    document.querySelector('.inkjet-turn-indicator__follow')?.getAttribute('aria-pressed') === 'false'
  );
  assert.equal(await page.locator('.text-block').first().getAttribute('contenteditable'), 'false', 'text blocks are read-only while the agent holds the document');
  // Live streaming: partial content must be visible while the lock is still on.
  await page.waitForFunction(() =>
    document.querySelector('.workspace--agent-locked') &&
    [...document.querySelectorAll('.text-block')].some((element) => element.textContent.includes('The agent'))
  );
  // Mid-turn, the process note types into the ephemeral thinking bubble while
  // no persisted answer card exists yet (text reveals as a typewriter, so wait
  // for the full phrase rather than sampling once).
  await page.waitForFunction(() =>
    document.querySelector('.workspace--agent-locked') &&
    (document.querySelector('.inkjet-entry--thinking')?.textContent ?? '').includes('Planning a short report page') &&
    document.querySelectorAll('.inkjet-entry--agent').length === 0
  );
  // The answer card reveals as a fast typewriter: it must be observable with
  // partial text before the full answer is on screen.
  await page.waitForFunction(() => {
    const card = document.querySelector('.inkjet-entry--agent');
    return card && card.textContent.length > 0 && !card.textContent.includes('streaming the text');
  });
  await page.locator('.workspace--agent-locked').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.inkjet-lock-scrim').count(), 0, 'the lock scrim leaves with the turn');
  await page.waitForFunction(() =>
    (document.querySelector('.inkjet-entry--agent')?.textContent ?? '').includes('streaming the text')
  );
  assert.equal(await page.locator('.inkjet-entry--thinking').count(), 0, 'the process bubble is replaced when the final answer lands');
  const agentMockLog = await page.evaluate(() => window.__inktileAgentMockState.log);
  assert.equal(agentMockLog.error, null, `the mocked agent turn completed without protocol errors: ${agentMockLog.error}`);
  assert.equal(agentMockLog.opFailure, null, `every full-control op succeeded: ${agentMockLog.opFailure}`);
  assert.equal(agentMockLog.model, 'sonnet', 'the prompt carries the model chosen at session start');
  assert.equal(agentMockLog.staleRejected, true, 'a write against a stale revision is rejected with a revision error');
  // Pixel geometry: the snapshot reports real sizes and media rows auto-fit their aspect.
  const imageSizing = agentMockLog.imageSizing;
  assert.ok(imageSizing && imageSizing.pageWidth > 0, 'read_document reports the document pageWidth');
  assert.equal(imageSizing.widthPx, imageSizing.pageWidth, 'a full-row tile reports the document width as its rendered width');
  assert.equal(imageSizing.asset, '200x100', 'read_document reports intrinsic media dimensions');
  assert.equal(imageSizing.height, Math.round(imageSizing.pageWidth / 2), 'an inserted image auto-sizes its row to the media aspect ratio');
  // Stroke-level drawing control: full read, modify by id, precise delete, summaries.
  const strokeOps = agentMockLog.strokeOps;
  assert.equal(strokeOps.beforeCount, 2, 'read_drawing returns the full stroke list');
  assert.equal(strokeOps.beforeFirst.tool, 'pen', 'read_drawing reports each stroke tool');
  assert.equal(strokeOps.beforeFirst.points.length, 3, 'read_drawing returns per-stroke point data');
  assert.ok(strokeOps.canvas.widthPx > 0 && strokeOps.canvas.height === 260, 'read_drawing reports the canvas geometry');
  assert.equal(strokeOps.afterCount, 1, 'delete_strokes removed exactly the targeted stroke');
  assert.equal(strokeOps.afterFirst.tool, 'highlighter', 'modify_strokes restyled the stroke tool');
  assert.equal(strokeOps.afterFirst.width, 8, 'modify_strokes set the stroke width');
  assert.deepEqual(
    strokeOps.afterFirst.points.map((point) => `${point.x},${point.y}`),
    ['0.3,0.15', '0.6,0.35', '0.9,0.75'],
    'modify_strokes translated the stroke points'
  );
  const strokeSummary = agentMockLog.strokeSummary;
  assert.ok(
    strokeSummary && strokeSummary.pointCount === 3 && strokeSummary.bounds.x0 === 0.3 && strokeSummary.bounds.y1 === 0.75,
    'read_document carries per-stroke summaries with bounds'
  );
  // Sizing ops mirror the UI's own limits: content-floor clamping and column minimums.
  assert.equal(agentMockLog.clampedHeight, 240, 'set_row_height clamps to the row content floor and reports the applied value');
  assert.equal(agentMockLog.narrowRejected, true, 'set_row_widths rejects columns narrower than the app minimum');
  // Text + drawing + audio pages remain; the versions page was inserted, reworked, then deleted.
  assert.equal(await page.locator('.page-wrapper').count(), pagesBeforeAgentTurn + 3, 'the turn added a text, a drawing, and an audio page');
  assert.ok(await page.locator('.page-row__cell--born').count() >= 3, 'tiles created during the turn carry the born fade-in class');
  assert.equal(await page.locator('.variant-block').count(), versionsBeforeAgentTurn, 'the versions page the agent created and deleted is gone');
  assert.equal(await page.locator('.page-card--drawing').count(), drawingsBeforeAgentTurn + 1, 'the agent authored a drawing page');
  assert.equal(await page.locator('.document-title').inputValue(), 'Inkjet Report', 'the agent renamed the document');
  const agentPageText = await page.locator('.page-wrapper').filter({ hasText: 'Agent report:' }).locator('.page-face--front .text-block').innerText();
  assert.match(agentPageText, /Agent report:\s*The agent streamed this sentence word by word\./, 'streamed appends assembled the complete text');
  // edit_notes wrote the tile's back face without flipping it.
  const agentNotesText = await page.locator('.page-wrapper').filter({ hasText: 'Agent report:' }).locator('.page-face--back .text-block').innerText();
  assert.match(agentNotesText, /note from inkjet/, 'the agent wrote the page notes');
  // Audio must land as a decodable asset: real controls and the exact MIME of the bytes.
  assert.equal(await page.locator('audio').count(), 1, 'the agent inserted an audio page');
  const audioProbe = await page.evaluate(async () => {
    const element = document.querySelector('audio');
    const blob = await (await fetch(element.src)).blob();
    return { controls: element.hasAttribute('controls'), type: blob.type, size: blob.size };
  });
  assert.equal(audioProbe.controls, true, 'the audio page renders playback controls');
  assert.equal(audioProbe.type, 'audio/wav', 'the audio asset keeps the true MIME of its bytes');
  assert.ok(audioProbe.size > 0, 'the audio asset carries its bytes');
  assert.equal(await page.locator('.text-block').first().getAttribute('contenteditable'), 'true', 'ending the turn returns the document to the user');
  assert.match(await page.locator('.inkjet-entry--agent').first().innerText(), /report/i, 'the panel shows the final answer as a persisted card');
  // The answer renders as markdown (React elements, no raw HTML injection).
  const agentBubble = page.locator('.inkjet-entry--agent').first();
  assert.equal(await agentBubble.locator('strong').innerText(), 'short report', 'the answer renders markdown bold');
  assert.equal(await agentBubble.locator('ul li').count(), 2, 'the answer renders markdown lists');
  // The transcript uses the shared overlay scrollbar instead of the native one.
  assert.equal(
    await page.locator('.inkjet-panel__transcript').evaluate((element) => getComputedStyle(element).scrollbarWidth),
    'none',
    'the transcript hides the native scrollbar'
  );
  await page.locator('.inkjet-panel__transcript-wrap').evaluate((element) => { element.style.maxHeight = '90px'; });
  await page.locator('.inkjet-scrollbar .element-scrollbar__handle').waitFor({ state: 'visible' });
  await page.locator('.inkjet-panel__transcript').evaluate((element) => { element.scrollTop = 0; });
  const scrollHandle = await page.locator('.inkjet-scrollbar .element-scrollbar__handle').boundingBox();
  await dragPointer(scrollHandle.x + scrollHandle.width / 2, scrollHandle.y + scrollHandle.height / 2, scrollHandle.x + scrollHandle.width / 2, scrollHandle.y + scrollHandle.height / 2 + 60);
  assert.ok(
    await page.locator('.inkjet-panel__transcript').evaluate((element) => element.scrollTop) > 0,
    'dragging the overlay handle scrolls the transcript'
  );
  await page.locator('.inkjet-panel__transcript-wrap').evaluate((element) => { element.style.maxHeight = ''; });
  await page.evaluate(() => { const element = window.document.activeElement; if (element && element !== window.document.body && typeof element.blur === 'function') element.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.page-wrapper').count(), pagesBeforeAgentTurn, 'a whole agent turn reverts with a single undo');
  assert.equal(await page.locator('audio').count(), 0, 'undo removes the inserted audio page');
  assert.equal(await page.locator('.document-title').inputValue(), titleBeforeAgentTurn, 'undo restores the document title');

  // Stop: a runaway turn ends on the indicator's stop button and keeps partial work.
  await page.getByLabel('Inkjet prompt').fill('slow drip until stopped');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('.workspace--agent-locked') &&
    [...document.querySelectorAll('.text-block')].some((element) => element.textContent.includes('drip'))
  );
  // The agent's reasoning streams as a temporary, visually distinct thinking
  // bubble (dashed frame, unlike a finished message's solid card).
  await page.locator('.inkjet-entry--thinking').waitFor({ state: 'visible' });
  // The reasoning types out gradually; wait for the whole phrase to reveal.
  await page.waitForFunction(() =>
    (document.querySelector('.inkjet-entry--thinking')?.textContent ?? '').includes('Planning the slow drip, one word at a time…')
  );
  assert.equal(
    await page.locator('.inkjet-entry--thinking').evaluate((element) => getComputedStyle(element).borderTopStyle),
    'dashed',
    'thinking is styled distinctly from a finished message (dashed frame)'
  );
  await page.locator('.inkjet-turn-indicator').getByRole('button', { name: 'Stop' }).click();
  await page.locator('.workspace--agent-locked').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.inkjet-entry--thinking').count(), 0, 'thinking text is temporary — it clears when the turn ends');
  const dripSurvivesStop = await page.evaluate(() => [...document.querySelectorAll('.text-block')].some((element) => element.textContent.includes('drip')));
  assert.equal(dripSurvivesStop, true, 'stopping keeps whatever the agent already wrote');
  await page.evaluate(() => { const element = window.document.activeElement; if (element && element !== window.document.body && typeof element.blur === 'function') element.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  const dripSurvivesUndo = await page.evaluate(() => [...document.querySelectorAll('.text-block')].some((element) => element.textContent.includes('drip')));
  assert.equal(dripSurvivesUndo, false, 'a stopped turn still reverts as one undo step');
  assert.equal(await page.locator('.page-wrapper').count(), pagesBeforeAgentTurn, 'the stopped turn leaves no leftover pages after undo');
  // "Exit session" returns to the provider screen.
  await page.getByRole('button', { name: 'Exit session' }).click();
  await page.getByRole('button', { name: 'Start session' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Inkjet panel' }).click();

  const homeChangedViewNextFrame = await page.getByRole('button', { name: 'Back to inktiles' }).evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return Boolean(document.querySelector('.library'));
  });
  assert.ok(homeChangedViewNextFrame, 'returning home changes view by the next animation frame');
  await page.locator('.inktile-card[data-inktile-id]').waitFor({ state: 'visible' });
  assert.match(await page.locator('.inktile-card[data-inktile-id]').first().innerText(), /Untitled Inktile/i, 'the edited inktile returns to the home library');

  // Rich text structures — checklists, tables, markdown autoformat, and KaTeX math — get
  // their own fresh inktile so they cannot disturb the earlier layout assertions.
  await page.getByRole('button', { name: /^New inktile/ }).click();
  await page.locator('.page-insert__trigger').waitFor({ state: 'visible' });
  await page.locator('.document-title').fill('Rich content');
  await page.locator('.page-insert__trigger').click();
  await page.getByRole('button', { name: /^Text Write/ }).click();
  const richText = page.locator('.text-block').first();
  await richText.click();

  // Markdown autoformat: "1. " converts on the space, and one undo restores the marker.
  await page.keyboard.type('1. ');
  await page.waitForTimeout(30);
  assert.equal(await richText.locator('ol').count(), 1, 'typing "1. " autoformats into an ordered list');
  await page.evaluate(() => { const element = window.document.activeElement; if (element && element !== window.document.body && typeof element.blur === 'function') element.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  assert.equal(await richText.locator('ol').count(), 0, 'undoing the autoformat removes the list');
  assert.match(await richText.innerText(), /1\./, 'undoing the autoformat restores the literal marker');

  // The dropdown's "Insert divider line" drops a full-width rule at the caret — the
  // same <hr> the "---" autoformat produces.
  await richText.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'More formatting' }).click();
  await page.getByRole('menuitem', { name: 'Insert divider line' }).click();
  await page.waitForTimeout(40);
  assert.equal(await richText.locator('hr').count(), 1, 'the dropdown inserts a horizontal rule at the caret');

  // Checklist: "[] " starts one, the gutter click toggles state without editing text, and
  // Enter after a checked item starts an unchecked one.
  await richText.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('[] ');
  assert.equal(await richText.locator('ul.checklist').count(), 1, 'typing "[] " starts a checklist');
  await page.keyboard.type('first task');
  await page.getByRole('button', { name: 'More formatting' }).click();
  assert.equal(
    await page.getByRole('menuitem', { name: 'Checklist' }).evaluate((button) => button.classList.contains('is-active')),
    true,
    'the Checklist item shows an active state inside a checklist'
  );
  assert.equal(
    await page.getByRole('menuitem', { name: 'Bulleted list' }).evaluate((button) => button.classList.contains('is-active')),
    false,
    'the bullet item stays off inside a checklist (the ul is decorated, not plain)'
  );
  await page.keyboard.press('Escape');
  await page.locator('.format-menu').waitFor({ state: 'detached' });
  const checkItemBox = await richText.locator('ul.checklist > li').first().boundingBox();
  await page.mouse.click(checkItemBox.x + 8, checkItemBox.y + 10);
  assert.equal(await richText.locator('ul.checklist > li').first().getAttribute('data-checked'), 'true', 'clicking the box checks the item');
  assert.match(await richText.locator('ul.checklist > li').first().innerText(), /first task/, 'toggling the box does not edit the item text');
  await richText.locator('ul.checklist > li').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second task');
  assert.deepEqual(
    await richText.locator('ul.checklist > li').evaluateAll((items) => items.map((item) => item.getAttribute('data-checked'))),
    ['true', 'false'],
    'Enter after a checked item starts an unchecked one'
  );

  // Tables: toolbar insert seats the caret in the first header cell, Tab walks the cells
  // (appending a row from the last one), and the text context menu edits structure.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'More formatting' }).click();
  await page.getByRole('menuitem', { name: 'Insert table' }).click();
  assert.equal(await richText.locator('table.text-table').count(), 1, 'the toolbar inserts a table');
  assert.equal(await richText.locator('table.text-table tr').count(), 3, 'the starter table has three rows');
  await page.keyboard.type('Header A');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Header B');
  assert.match(await richText.locator('table.text-table th').first().innerText(), /Header A/, 'typing lands in the first header cell');
  assert.match(await richText.locator('table.text-table th').nth(1).innerText(), /Header B/, 'Tab moves the caret to the next cell');
  await richText.locator('table.text-table tr:last-child td:last-child').click();
  await page.keyboard.press('Tab');
  assert.equal(await richText.locator('table.text-table tr').count(), 4, 'Tab on the last cell appends a row');
  await richText.locator('table.text-table td').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert column right' }).click();
  assert.equal(await richText.locator('table.text-table tr').first().locator('th').count(), 4, 'the context menu inserts a column across every row');
  await richText.locator('table.text-table td').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete row' }).click();
  assert.equal(await richText.locator('table.text-table tr').count(), 3, 'the context menu deletes the clicked row');

  // Context-menu table edits are discrete undo steps — and undo must repaint even though
  // the tile still holds focus (history restore releases rich-text focus first).
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(60);
  assert.equal(await richText.locator('table.text-table tr').count(), 4, 'a context-menu table edit undoes as one discrete step, without blurring first');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(60);
  assert.equal(await richText.locator('table.text-table tr').count(), 3, 'redo reapplies the table edit');

  // Up/Down arrows step between table rows, staying in the same column.
  const caretCellProbe = () => page.evaluate(() => {
    const selection = document.getSelection();
    const node = selection ? selection.anchorNode : null;
    const element = node ? (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) : null;
    const cell = element ? element.closest('td, th') : null;
    return cell ? { tag: cell.tagName, column: cell.cellIndex } : null;
  });
  await richText.locator('table.text-table th').first().click();
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await caretCellProbe(), { tag: 'TD', column: 0 }, 'ArrowDown jumps from the header into the next row, same column');
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await caretCellProbe(), { tag: 'TH', column: 0 }, 'ArrowUp jumps back up into the header row');

  // Math fields: the editor previews KaTeX, the field stores only TeX (empty light DOM,
  // KaTeX in the shadow root), and clicking a field reopens its source.
  await richText.locator('table.text-table td').first().click();
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'More formatting' }).click();
  await page.getByRole('menuitem', { name: 'Insert math' }).click();
  await page.locator('.math-editor').waitFor({ state: 'visible' });
  await page.locator('.math-editor__source').fill('E = mc^2');
  await page.waitForFunction(() => document.querySelector('.math-editor__preview .katex'));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('.math-editor').waitFor({ state: 'detached' });
  const mathProbe = await richText.locator('.math-field').first().evaluate((element) => ({
    tex: element.getAttribute('data-tex'),
    light: element.innerHTML,
    shadowKatex: Boolean(element.shadowRoot && element.shadowRoot.querySelector('.katex'))
  }));
  assert.equal(mathProbe.tex, 'E = mc^2', 'the math field stores its TeX source');
  assert.equal(mathProbe.light.replace(/​/g, ''), '', 'the math field keeps an empty light DOM — KaTeX lives in the shadow root, never in stored HTML');
  assert.equal(mathProbe.shadowKatex, true, 'the math field renders KaTeX into its shadow root');
  await richText.locator('.math-field').first().click();
  await page.locator('.math-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.math-editor__source').inputValue(), 'E = mc^2', 'clicking a math field reopens its TeX source');
  await page.locator('.math-editor__display input').check();
  await page.getByRole('button', { name: 'Done' }).click();
  assert.equal(await richText.locator('.math-field').first().getAttribute('data-display'), 'true', 'display mode persists on the field');

  // Saving math refocuses the tile; Ctrl+Z straight after must still visibly revert
  // (undo releases tile focus so the restored HTML repaints), and redo restores it.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(60);
  assert.equal(await richText.locator('.math-field').first().getAttribute('data-display'), 'false', 'Ctrl+Z right after saving math reverts the edit without a manual blur');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(60);
  assert.equal(await richText.locator('.math-field').first().getAttribute('data-display'), 'true', 'Ctrl+Y restores the reverted math edit');

  // Ctrl+Z while typing in the math editor's textarea stays native text undo: the
  // document's structural undo must not fire underneath the popover.
  await richText.locator('.math-field').first().click();
  await page.locator('.math-editor').waitFor({ state: 'visible' });
  await page.keyboard.press('End');
  await page.keyboard.type('+x');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.math-editor').count(), 1, 'structural undo does not fire while the TeX textarea has focus');
  assert.equal(await richText.locator('.math-field').first().getAttribute('data-display'), 'true', 'the document is untouched by textarea undo');
  await page.keyboard.press('Escape');
  await page.locator('.math-editor').waitFor({ state: 'detached' });

  // Links: a URL followed by a space autolinks (the space lands outside the anchor), a
  // plain click opens the preview popover instead of navigating, and Ctrl+Click opens
  // externally right away. The target is served by the smoke server so the embedded
  // preview loads deterministically.
  const previewUrl = `${smokeUrl}migration-seed`;
  await richText.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`see ${previewUrl} next`);
  const autoLink = richText.locator(`a[href="${previewUrl}"]`);
  assert.equal(await autoLink.count(), 1, 'typing a URL followed by a space autolinks it');
  assert.doesNotMatch(await autoLink.innerText(), /next/, 'the triggering space and later typing land outside the link');
  await autoLink.click();
  assert.equal(new URL(page.url()).pathname, '/', 'a plain click on a tile link does not navigate the app');
  await page.locator('.link-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.link-preview input[aria-label="Link URL"]').inputValue(), previewUrl, 'the popup offers the destination URL for editing');
  assert.equal(await page.locator('.link-preview input[aria-label="Link text"]').inputValue(), previewUrl, 'the popup offers the display text for editing');
  // The preview section stays hidden until the embedded page actually loads.
  await page.waitForFunction(() => {
    const frame = document.querySelector('.link-preview__frame');
    return frame && frame.getBoundingClientRect().height > 100;
  });
  assert.equal(await page.locator('.link-preview__frame object').getAttribute('data'), previewUrl, 'the popup embeds a preview of the destination');
  const previewPopupPromise = context.waitForEvent('page');
  await page.locator('.link-preview').getByRole('button', { name: 'Open link' }).click();
  const previewPopup = await previewPopupPromise;
  await previewPopup.close();
  assert.equal(new URL(page.url()).pathname, '/', 'opening from the popup leaves the app where it was');
  // Inline edit: rewriting the display text keeps the destination.
  await page.locator('.link-preview input[aria-label="Link text"]').fill('seed page');
  await page.locator('.link-preview').getByRole('button', { name: 'Apply' }).click();
  await page.locator('.link-preview').waitFor({ state: 'detached' });
  assert.equal((await autoLink.innerText()).trim(), 'seed page', 'Apply rewrites the link text in place');
  assert.equal(await autoLink.getAttribute('href'), previewUrl, 'the destination stays when only the text changes');
  await autoLink.click();
  await page.locator('.link-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.link-preview input[aria-label="Link text"]').inputValue(), 'seed page', 'reopening the popup prefills the current text');
  await page.keyboard.press('Escape');
  await page.locator('.link-preview').waitFor({ state: 'detached' });

  // A destination that refuses embedding (X-Frame-Options, like most large sites) must
  // show no preview section at all: Chromium commits its "sad file" error page and still
  // fires load, so the popup reveals the frame only for provable non-error loads.
  const deniedUrl = `${smokeUrl}framed-deny`;
  await richText.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` ${deniedUrl} `);
  const deniedLink = richText.locator(`a[href="${deniedUrl}"]`);
  assert.equal(await deniedLink.count(), 1, 'the embedding-refusing URL autolinks too');
  await deniedLink.click();
  await page.locator('.link-preview').waitFor({ state: 'visible' });
  await page.waitForTimeout(700);
  assert.ok(
    await page.locator('.link-preview__frame').evaluate((element) => element.getBoundingClientRect().height < 2),
    'a site that refuses embedding shows no preview section (no error-page thumbnail)'
  );
  await page.keyboard.press('Escape');
  await page.locator('.link-preview').waitFor({ state: 'detached' });

  // Pasting a URL autolinks too: at a caret it inserts the linked URL, over a selection
  // it links the selected text.
  const dispatchPaste = (payload) => richText.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, payload);
  await richText.click();
  await page.keyboard.press('Control+End');
  const pastedUrl = 'https://example.net/spec';
  await dispatchPaste(pastedUrl);
  const pastedLink = richText.locator(`a[href="${pastedUrl}"]`);
  assert.equal(await pastedLink.count(), 1, 'pasting a bare URL at the caret inserts it as a link');
  assert.equal((await pastedLink.innerText()).trim(), pastedUrl, 'the pasted link keeps the URL as its text');
  await page.keyboard.type(' after');
  assert.doesNotMatch(await pastedLink.innerText(), /after/, 'typing after a pasted link stays outside it');
  await page.keyboard.type(' target');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await dispatchPaste('www.example.net/wrapped');
  const wrappedLink = richText.locator('a[href="https://www.example.net/wrapped"]');
  assert.equal(await wrappedLink.count(), 1, 'pasting a URL over a selection links it (www gets https://)');
  assert.equal((await wrappedLink.innerText()).trim(), 'target', 'the selection keeps its text as the link label');
  await page.keyboard.type(' ');
  // Ctrl+Click bypasses the preview and opens the destination directly.
  const popupPromise = context.waitForEvent('page');
  await autoLink.click({ modifiers: ['Control'] });
  const linkPopup = await popupPromise;
  await linkPopup.close();
  assert.equal(await page.locator('.link-preview').count(), 0, 'Ctrl+Click does not open the preview popover');

  // The link editor: Ctrl+K wraps the current selection, normalizing bare domains.
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' guide');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  await page.locator('.link-menu').waitFor({ state: 'visible' });
  await page.locator('.link-menu input').fill('example.org/guide');
  await page.keyboard.press('Enter');
  await page.locator('.link-menu').waitFor({ state: 'detached' });
  const guideLink = richText.locator('a[href="https://example.org/guide"]');
  assert.equal(await guideLink.count(), 1, 'Ctrl+K wraps the selection in a link and bare domains get https://');
  assert.equal((await guideLink.innerText()).trim(), 'guide', 'the link keeps the selected text');

  // The rich structures survive a save/reopen cycle, and the mount pass re-renders math
  // from the persisted TeX alone.
  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.getByRole('button', { name: 'Open Rich content' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Open Rich content' }).click();
  await page.locator('.text-block').first().waitFor({ state: 'visible' });
  const reopenedRich = page.locator('.text-block').first();
  assert.equal(await reopenedRich.locator('ul.checklist > li[data-checked="true"]').count(), 1, 'checklist state survives a save/reopen cycle');
  assert.equal(await reopenedRich.locator('table.text-table').count(), 1, 'the table survives a save/reopen cycle');
  assert.equal(await reopenedRich.locator(`a[href="${previewUrl}"]`).count(), 1, 'links survive a save/reopen cycle');
  await page.waitForFunction(() => {
    const field = document.querySelector('.text-block .math-field');
    return field && field.shadowRoot && field.shadowRoot.querySelector('.katex');
  });

  // Plain-text export keeps the structures legible: [x] items, pipe-separated rows, TeX.
  const richExportPromise = page.waitForEvent('download');
  await page.locator('button[title="Export…"]').click();
  await page.locator('.export-option', { hasText: 'Text file' }).click();
  const richExportText = await readFile(await (await richExportPromise).path(), 'utf8');
  assert.match(richExportText, /\[x\] first task/, 'text export renders checked items as [x]');
  assert.match(richExportText, /\[ \] second task/, 'text export renders unchecked items as [ ]');
  // The inserted column sits between the two headers, so the row reads A | (empty) | B.
  assert.match(richExportText, /Header A \|\s+\| Header B/, 'text export renders table rows pipe-separated');
  assert.ok(richExportText.includes('$$E = mc^2$$'), 'text export keeps display math as TeX');
  assert.match(richExportText, /guide \(https:\/\/example\.org\/guide\)/, 'text export keeps link destinations visible');
  assert.ok(richExportText.includes(`seed page (${previewUrl})`), 'text export shows the destination for renamed links');

  await page.getByRole('button', { name: 'Back to inktiles' }).click();
  await page.locator('.inktile-card[data-inktile-id]').first().waitFor({ state: 'visible' });
  await page.screenshot({ path: 'inktile-preview.png', fullPage: true });
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join('\n')}`);
  console.log('Browser interaction smoke test passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => smokeServer.close(resolve));
}
