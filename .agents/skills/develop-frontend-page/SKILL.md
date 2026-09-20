---
name: develop-frontend-page
description: Use when adding or changing a dashboard page or its widgets — "加一个页面"、"这个表格要支持排序"、"图表配色不对"、"筛选器要在页面间共享"、"详情抽屉要展示更多维度". Covers the data layer, global filter contract, chart/table conventions, and the build+render self-check.
whenToUse: 前端页面的新增、改版、组件抽取，或图表/表格表现不符合看板规范时。
---

# 开发看板页面

页面层只做两件事：**取数**与**表达**。任何聚合口径都不属于这一层 —— 它只在
`backend/app/metrics.py` 里存在一份实现。破坏这条边界是这类项目最常见的返工来源。

## 完成标准

- 页面只通过 `lib/api.ts` 取数（组件内无 `fetch`）；
- 筛选条件来自 `useScope()`，切页/切组件后不丢；
- `npm run typecheck` 0 error，`npm run build` 成功；
- `npm run verify -- <url>` 该页 OK（无控制台错误、无失败请求、关键文案渲染、有截图）；
- 若新增了展示口径，`MetricsPage.tsx` 的指标字典已同步。

## 步骤

### 1. 定位数据来源

先判断数据是否已存在：多数页面所需字段都能由 `/api/v1/efficiency/overview` 或
`/api/v1/efficiency/members` 提供。确实需要新字段时，**先走 `add-metric` skill**，
不要在前端拼算。

在 `lib/api.ts` 中新增方法时遵守：

- 一律经 `request<T>()` 包装（统一处理 `{code, msg, data}` 与错误提示）；
- 返回类型从 `lib/types.ts` 引入，不写内联匿名结构；
- 区间参数用 `rangeQuery(scope)` 生成，保证所有接口的时间/部门参数写法一致。

### 2. 接入全局筛选

```tsx
const { range, departmentIds, loading, error, overview } = useScope()
```

- 区间与部门**必须**取自这里。页面自己维护一份 `useState<DateRange>` 会导致
  「切页后筛选漂移」，进而让两个页面的数看起来打架。
- 需要按部门下钻时，用 `useSearchParams()` 传 `?dept=`，让链接可分享、可回退。
- 请求竞态用递增 `requestId` 或 `alive` 标志丢弃过期响应（参考 `MembersPage` 的写法）。

### 3. 组装展示

- **KPI 卡**：用 `MetricCardGrid` + `KpiItem`。消耗类指标设 `higherIsBetter: false`；
  比率变化设 `deltaUnit: 'point'`；有日粒度数据时给 `spark`（近 14 天）提供趋势语境；
  每个指标写 `hint`（口径一句话）。
- **图表**：option 用 `useMemo`；颜色从 `lib/theme.ts` 取（`COLORS` / `SERIES_PALETTE`
  / `CHART_BASE` / `axisLabel` / `splitLine`）；面积图用 `areaGradient`；
  空数据用 `chartEmptyOption()` 给提示而不是留白；细节见 `references/chart-recipes.md`。
- **表格**：用 `DataTable`。数值列 `align: 'right'` 自动获得等宽对齐；
  列头 `tooltip` 写口径；服务端排序传 `sortBy/sortOrder + onSortChange`，
  本地数据用 `localSort` + `defaultSort`；每列 `render` 里禁止 `toFixed`，
  统一用 `lib/format.ts`。
- **比率展示**：数值 + `ProgressBar` 并列，比纯数字更容易横向比较。
- **空态**：区分三种语义 —— 无数据（调整筛选）、指标不可用（后端报错/降级）、
  未命中（放宽阈值）。文案都要给出下一步动作。

### 4. 注册路由与导航

在 `App.tsx` 的 `Routes` 中加 `<Route>`；需要出现在侧边栏时同步 `Layout.tsx` 的
`NAV_ITEMS`（含 `label` / `icon` / `desc`）。

### 5. 自检

```bash
cd frontend && npm run typecheck && npm run build
npm run verify -- http://127.0.0.1:8000     # 需先在仓库根启动 server.py
```

若新增页面，在 `scripts/verify-pages.mjs` 的 `PAGES` 中登记，并给出该页**必须出现**的
关键文案（`expect`），否则「渲染成功」无从判定。

## 约定速查

| 事项 | 做法 |
|---|---|
| 数字格式化 | `fmtInt` / `fmtCompact` / `fmtCredit` / `fmtPercent` / `fmtDelta`（`lib/format.ts`） |
| 时间显示 | `fmtDate` / `fmtDateTime` / `fmtRelative`；mock 数据要用数据集参考日做基准 |
| 风险标签 | `riskOf()` + `RISK_META`，不要自建色值 |
| 导出 | `downloadCsv()`，导出内容必须与当前筛选一致 |
| 主题色 | 只用 `tailwind.config.js` 里声明的 `ink/brand/cyan/mint/amber/rose/violet` |
| 组件复用 | 先查 `src/components/`，不要复制粘贴表格/卡片 |
