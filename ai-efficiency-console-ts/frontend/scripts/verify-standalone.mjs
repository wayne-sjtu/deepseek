/**
 * 单文件版自检：用无头 Chrome 以 `file://` 直接打开那个 HTML，逐页检查。
 *
 * 与 `verify-pages.mjs`（走 http）的区别：
 *   - 用 `file://` + **hash 路由**访问（单文件版用的是 HashRouter）；
 *   - 额外断言「没有对外网络请求」——单文件版一旦偷偷发起请求，
 *     离线打开就会失败，这正是它最容易退化的地方。
 *
 * 用法：node scripts/verify-standalone.mjs [html 路径]
 */

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const file = resolve(process.argv[2] ?? resolve(repo, 'ai-efficiency-console.html'));
const OUT = resolve(here, '..', 'verification-standalone');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(file)) {
  console.error(`✗ 找不到单文件产物：${file}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PAGES = [
  { hash: '#/', name: '00-root', expect: ['AI 效能运营台'] },
  { hash: '#/overview', name: '01-overview', expect: ['用量消耗', '部门用量排行'] },
  { hash: '#/departments', name: '02-departments', expect: ['部门明细表'] },
  { hash: '#/members', name: '03-members', expect: ['个人效能', '新增代码行'] },
  { hash: '#/quota', name: '04-quota', expect: ['额度管理', '成员额度与消耗明细'] },
  { hash: '#/metrics', name: '05-metrics', expect: ['指标口径说明', '先求和再相除'] },
];

const base = `file://${file}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1100'],
});

let failures = 0;
console.log(`单文件自检：${file}\n`);

for (const page of PAGES) {
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 2 });
  const errors = [];
  const external = [];
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  tab.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  tab.on('request', (req) => {
    const u = req.url();
    // 单文件版不该发起任何 http(s) 请求；file:// 自身与 data: 都不算
    if (u.startsWith('http://') || u.startsWith('https://')) external.push(u);
  });

  const t0 = Date.now();
  await tab.goto(`${base}${page.hash}`, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1800));

  const text = await tab.evaluate(() => document.body.innerText);
  const canvas = await tab.evaluate(() => document.querySelectorAll('canvas').length);
  const missing = page.expect.filter((k) => !text.includes(k));
  const ok = missing.length === 0 && errors.length === 0 && external.length === 0;
  if (!ok) failures += 1;

  console.log(
    `[${ok ? 'OK  ' : 'FAIL'}] ${page.hash.padEnd(16)} ${String(Date.now() - t0).padStart(5)}ms  ` +
      `canvas=${canvas}  文本长度=${text.length}`,
  );
  if (missing.length) console.log(`        缺少文案: ${missing.join(', ')}`);
  for (const e of errors.slice(0, 3)) console.log(`        控制台错误: ${e}`);
  for (const u of external.slice(0, 3)) console.log(`        发起了外部请求: ${u}`);

  await tab.screenshot({ path: resolve(OUT, `${page.name}.png`), fullPage: false });
  await tab.close();
}

// —— 交互抽查：抽屉与筛选（单文件版同样要能点） ——
const tab = await browser.newPage();
await tab.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 2 });
const errors = [];
tab.on('pageerror', (e) => errors.push(e.message));
await tab.goto(`${base}#/members`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1800));

const drawer = await tab.evaluate(async () => {
  const before = document.body.innerText.length;
  const row = document.querySelector('tbody tr');
  if (!row) return { opened: false, reason: '找不到成员表格行' };
  row.click();
  await new Promise((r) => setTimeout(r, 900));
  const after = document.body.innerText.length;
  const dialog = document.querySelector('[role="dialog"], .fixed.inset-0, aside');
  return { opened: after > before && !!dialog, before, after };
});
console.log(
  `[${drawer.opened ? 'OK  ' : 'FAIL'}] 成员详情抽屉     打开=${drawer.opened}` +
    (drawer.reason ? ` (${drawer.reason})` : ` 文本 ${drawer.before}→${drawer.after}`),
);
if (!drawer.opened) failures += 1;
for (const e of errors.slice(0, 3)) console.log(`        控制台错误: ${e}`);
await tab.screenshot({ path: resolve(OUT, '06-drawer.png') });
await tab.close();

await browser.close();
console.log(
  `\n${failures === 0 ? '单文件版逐页自检全部通过' : `${failures} 项未通过`}\n截图目录：${OUT}`,
);
process.exit(failures === 0 ? 0 : 1);
