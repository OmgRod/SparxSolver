import { chromium } from 'playwright';
import path from 'path';
import { setContext } from './server.ts';

(async () => {
  const extensionPath = path.resolve('./extension/dist');

  const context = await chromium.launchPersistentContext('./browser-data', {
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  setContext(context);
  const page = await context.newPage();

  // Wait a short time to ensure the server is fully ready
  await new Promise(r => setTimeout(r, 1000));

  await page.goto('http://localhost:3000');

  process.on('SIGINT', async () => {
    await context.close();
    process.exit();
  });
})();