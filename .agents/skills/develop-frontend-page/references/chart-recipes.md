# 图表写法速查

所有 option 用 `useMemo` 组装，颜色取自 `lib/theme.ts`，容器用 `components/Chart.tsx`。

## 折线 + 面积（趋势主图）

```tsx
import { Chart, areaGradient } from '../components/Chart'
import { COLORS, CHART_BASE } from '../lib/theme'
import { chartAxisLabel, chartSplitLine } from '../components/MetricCard'

const option = useMemo(() => ({
  ...CHART_BASE,
  grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
  legend: { ...CHART_BASE.legend, data: ['Credits 消耗'] },
  xAxis: { type: 'category', data: dates, boundaryGap: false,
           axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
  yAxis: { type: 'value', axisLabel: chartAxisLabel, splitLine: chartSplitLine },
  series: [{
    name: 'Credits 消耗', type: 'line', smooth: true, symbol: 'none',
    data: values, lineStyle: { width: 2, color: COLORS.amber },
    areaStyle: { color: areaGradient(COLORS.amber, 0.3, 0) },
  }],
}), [dates, values])
```

## 双轴：消耗 + 比率

消耗与占比画在同一张图上是本项目最有价值的组合（背离 = 钱花了没转成产出）。
比率的轴固定 `max: 100`，并把刻度标成百分比：

```tsx
yAxis: [
  { type: 'value', name: 'Credits', axisLabel: chartAxisLabel, splitLine: chartSplitLine },
  { type: 'value', name: '占比 %', max: 100, splitLine: { show: false },
    axisLabel: { ...chartAxisLabel, formatter: '{value}%' } },
],
series: [
  { name: 'Credits 消耗', type: 'line', data: credits /* 左轴 */ },
  { name: 'AI 代码占比', type: 'line', yAxisIndex: 1, data: rates,
    lineStyle: { color: COLORS.mint, type: 'dashed' } },
],
```

## 堆叠柱：AI 行 vs 人工行

呈现**结构**而非并列两个数。人工部分用半透明灰，AI 部分用品牌色：

```tsx
series: [
  { name: '人工编写', type: 'bar', stack: 'lines', barMaxWidth: 18,
    data: totals.map((t, i) => t - ai[i]),
    itemStyle: { color: 'rgba(100,116,139,0.55)', borderRadius: [0, 0, 3, 3] } },
  { name: 'AI 生成', type: 'bar', stack: 'lines', barMaxWidth: 18, data: ai,
    itemStyle: { color: COLORS.brand, borderRadius: [3, 3, 0, 0] } },
]
```

## 环形图（结构占比）

```tsx
series: [{
  type: 'pie', radius: ['46%', '72%'], center: ['50%', '46%'],
  itemStyle: { borderColor: '#0b1020', borderWidth: 2 },   // 与卡片底色一致，切出间隙
  label: { color: COLORS.label, fontSize: 11, formatter: '{b}\n{d}%' },
  data: items.map((item, index) => ({ name: item.label, value: item.value,
    itemStyle: { color: palette(index) } })),
}]
```

## 散点 + 中位数分界（诊断图）

气泡大小表达第三维（如人数），`markLine` 画分界，`data` 里挂原始行对象以便 tooltip 取用：

```tsx
symbolSize: (data: any) => 18 + (data[2] / maxMember) * 38,
data: rows.map((row) => ({ value: [row.aiCodeRate, row.credit, row.memberCount], row })),
markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: 'rgba(148,163,184,0.35)' },
  data: [{ yAxis: medianCredit, name: '消耗中位数' }, { xAxis: medianRate, name: '占比中位数' }] },
```

## 空数据

```tsx
{rows.length ? <Chart option={option} height={280} />
             : <Chart option={chartEmptyOption('暂无数据', '请调整时间范围或部门筛选')} height={280} />}
```

## 硬约束

| 约束 | 原因 |
|---|---|
| `option` 必须 `useMemo` | 每轮渲染新建对象会触发 ECharts 重绘 |
| 用 `components/Chart.tsx` | 已处理 `ResizeObserver` 自适应与卸载 `dispose` |
| 不在页面里写十六进制色 | 换肤与一致性；统一走 `theme.ts` |
| 数值型轴标签过万用 `fmtCompact(v, 0)` | 避免 6 位数字把刻度挤爆 |
| 时延/百分比轴标单位 | `ms` / `%`，否则读者会误读量级 |
