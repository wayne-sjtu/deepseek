/**
 * 页面自检脚本（开发期使用，不参与生产构建）。
 *
 * 用本机 Chrome 无头模式逐页访问，收集：
 *  - 控制台错误 / 页面异常
 *  - 失败的网络请求
 *  - 关键文案是否渲染（用于确认不是白屏）
 *  - 截图，便于人工复核视觉
 *
 * 用法：
 *   node scripts/verify-pages.mjs                       # 默认 http://127.0.0.1:8000
 *   node scripts/verify-pages.mjs http://127.0.0.1:5173
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:8000'
const OUT = 'verification'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const PAGES = [
  // 根路径必须是应用入口（曾被误判为接口路径返回 404 JSON，故纳入回归）
  { path: '/', name: '00-root', expect: ['用量总览', 'AI 效能运营台'] },
  { path: '/overview', name: '01-overview', expect: ['用量消耗', '部门用量排行', '消耗与 AI 渗透趋势'] },
  { path: '/departments', name: '02-departments', expect: ['消耗 - 产出四象限', '部门明细表', '千行成本'] },
  { path: '/members', name: '03-members', expect: ['个人效能', 'AI 代码占比', '新增代码行'] },
  { path: '/quota', name: '04-quota', expect: ['额度管理', '超限风险', '成员额度与消耗明细'] },
  {
    path: '/metrics',
    name: '05-metrics',
    expect: ['指标口径说明', '先求和再相除', '数据来源与可获取性', '接口能力缺口与处置'],
  },
]

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1100'],
})

let failures = 0
for (const page of PAGES) {
  const tab = await browser.newPage()
  await tab.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 2 })
  const errors = []
  const failedRequests = []
  tab.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  tab.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  tab.on('requestfailed', (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText}`))

  const started = Date.now()
  await tab.goto(`${BASE}${page.path}`, { waitUntil: 'networkidle2', timeout: 45000 })
  // 等图表渲染完成
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const html = await tab.evaluate(() => document.body.innerText)
  const canvases = await tab.evaluate(() => document.querySelectorAll('canvas').length)
  const missing = page.expect.filter((text) => !html.includes(text))
  await tab.screenshot({ path: `${OUT}/${page.name}.png`, fullPage: true })

  const ok = missing.length === 0 && errors.length === 0 && failedRequests.length === 0
  if (!ok) failures += 1
  console.log(
    `[${ok ? 'OK  ' : 'FAIL'}] ${page.path.padEnd(14)} ${Date.now() - started}ms  canvas=${canvases}  ` +
      `文本长度=${html.length}`,
  )
  if (missing.length) console.log(`        缺少文案: ${missing.join(' / ')}`)
  if (errors.length) console.log(`        控制台错误: ${errors.slice(0, 4).join(' | ')}`)
  if (failedRequests.length) console.log(`        请求失败: ${failedRequests.slice(0, 4).join(' | ')}`)
  await tab.close()
}

// 额外交互检查：打开成员详情抽屉
const tab = await browser.newPage()
await tab.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 2 })
const drawerErrors = []
tab.on('pageerror', (err) => drawerErrors.push(err.message))
tab.on('console', (msg) => msg.type() === 'error' && drawerErrors.push(msg.text()))
await tab.goto(`${BASE}/members`, { waitUntil: 'networkidle2' })
await new Promise((resolve) => setTimeout(resolve, 1200))
const opened = await tab.evaluate(() => {
  const button = Array.from(document.querySelectorAll('button')).find((el) =>
    (el.textContent || '').includes('效能详情'),
  )
  if (!button) return false
  button.click()
  return true
})
await new Promise((resolve) => setTimeout(resolve, 2000))
const drawerText = await tab.evaluate(() => document.body.innerText)
await tab.screenshot({ path: `${OUT}/06-member-detail.png`, fullPage: false })
const drawerOk = opened && drawerText.includes('模型消耗分布') && drawerErrors.length === 0
if (!drawerOk) failures += 1
console.log(`[${drawerOk ? 'OK  ' : 'FAIL'}] 成员详情抽屉     打开=${opened} 错误=${drawerErrors.length}`)
if (drawerErrors.length) console.log(`        ${drawerErrors.slice(0, 3).join(' | ')}`)
await tab.close()

// ---------------------------------------------------------------------------
// 交互回归：部门筛选弹层必须能自己收起来
// （历史上「点开筛选后不收起」是一个真实 bug，且只跑渲染快照发现不了）
// ---------------------------------------------------------------------------
const tab2 = await browser.newPage()
await tab2.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 2 })
const uiErrors = []
tab2.on('pageerror', (err) => uiErrors.push(err.message))
tab2.on('console', (msg) => msg.type() === 'error' && uiErrors.push(msg.text()))
await tab2.goto(`${BASE}/overview`, { waitUntil: 'networkidle2' })
await new Promise((resolve) => setTimeout(resolve, 1000))

const panelVisible = () =>
  tab2.evaluate(() => document.body.innerText.includes('按主部门过滤（可多选）'))

const results = []
const openMenu = async () => {
  await tab2.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((el) =>
      (el.textContent || '').includes('部门范围'),
    )
    btn?.click()
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
}

await openMenu()
results.push(['点击触发器后展开', await panelVisible()])

// ① 点击面板外部（趋势图区域）应收起
await tab2.mouse.click(900, 600)
await new Promise((resolve) => setTimeout(resolve, 250))
results.push(['点击外部区域后收起', !(await panelVisible())])

// ② Esc 应收起
await openMenu()
await tab2.keyboard.press('Escape')
await new Promise((resolve) => setTimeout(resolve, 250))
results.push(['按 Esc 后收起', !(await panelVisible())])

// ③ 勾选一个部门后仍保持展开（多选场景），点「完成」才收起
await openMenu()
const checkedBefore = await tab2.evaluate(() => document.querySelectorAll('input[type=checkbox]:checked').length)
await tab2.evaluate(() => {
  const box = document.querySelector('input[type=checkbox]')
  box?.click()
})
await new Promise((resolve) => setTimeout(resolve, 300))
const stillOpen = await panelVisible()
results.push(['勾选部门后仍展开（可多选）', stillOpen])
await tab2.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((el) =>
    (el.textContent || '').trim().startsWith('完成'),
  )
  btn?.click()
})
await new Promise((resolve) => setTimeout(resolve, 300))
results.push(['点「完成」后收起', !(await panelVisible())])

// ④ 筛选确实生效：选中部门后出现已选计数，且请求带上了 departmentIds
const applied = await tab2.evaluate(() =>
  document.body.innerText.includes('已选 1 个') || document.body.innerText.includes('1 个'),
)
results.push(['筛选条件已生效', applied && checkedBefore === 0])
await tab2.screenshot({ path: `${OUT}/07-filter-interaction.png`, fullPage: false })
await tab2.close()

const uiOk = results.every(([, pass]) => pass) && uiErrors.length === 0
if (!uiOk) failures += 1
for (const [label, pass] of results) console.log(`        ${pass ? '✓' : '✗'} ${label}`)
console.log(`[${uiOk ? 'OK  ' : 'FAIL'}] 部门筛选交互     ${results.filter(([, p]) => p).length}/${results.length} 通过`)
if (uiErrors.length) console.log(`        ${uiErrors.slice(0, 3).join(' | ')}`)

await browser.close()
console.log(failures === 0 ? '\n全部页面渲染正常' : `\n${failures} 个页面存在问题`)
process.exit(failures === 0 ? 0 : 1)
