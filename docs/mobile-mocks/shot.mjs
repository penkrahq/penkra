import { chromium } from "/Users/USER/Penkra/00000000-0000-4000-8000-000000000000/penkra-worktrees/release-0143/apps/web/node_modules/playwright/index.mjs";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 2166, height: 1900 }, deviceScaleFactor: 1 });
await p.goto("file:///tmp/pm/m.html");
await p.screenshot({ path: "/tmp/pm/m.png", fullPage: true });
await b.close();
