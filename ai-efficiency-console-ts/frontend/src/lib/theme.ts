/**
 * 全局设计令牌（颜色 / 图表主题）。
 * 图表颜色在此集中定义，页面不出现硬编码色值，便于后续换肤。
 */

export const COLORS = {
  brand: '#3b6dfb',
  brandSoft: '#5c8dff',
  cyan: '#35d6f0',
  mint: '#3ddc97',
  amber: '#ffc44d',
  rose: '#ff7089',
  violet: '#a78bfa',
  slate: '#64748b',
  axis: 'rgba(148,163,184,0.18)',
  label: '#8b9ab5',
} as const

/** 部门 / 系列的循环配色 */
export const SERIES_PALETTE = [
  COLORS.brand,
  COLORS.cyan,
  COLORS.mint,
  COLORS.violet,
  COLORS.amber,
  COLORS.rose,
  '#4ade80',
  '#f472b6',
  '#38bdf8',
  '#facc15',
  '#fb923c',
  '#94a3b8',
]

export const CHART_BASE = {
  textStyle: { color: COLORS.label, fontFamily: 'PingFang SC, Microsoft YaHei, Inter, sans-serif' },
  grid: { left: 12, right: 16, top: 32, bottom: 8, containLabel: true },
  tooltip: {
    trigger: 'axis' as const,
    backgroundColor: 'rgba(10,16,34,0.94)',
    borderColor: 'rgba(92,141,255,0.35)',
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: '#e6ecff', fontSize: 12 },
    axisPointer: { lineStyle: { color: 'rgba(92,141,255,0.45)' }, crossStyle: { color: 'rgba(92,141,255,0.45)' } },
  },
  legend: {
    textStyle: { color: COLORS.label, fontSize: 11 },
    itemWidth: 10,
    itemHeight: 10,
    icon: 'roundRect' as const,
    top: 0,
  },
}

export const AXIS_LABEL = { color: COLORS.label, fontSize: 11 }

export const SPLIT_LINE = {
  lineStyle: { color: COLORS.axis as string, type: 'dashed' as const },
}

/** 由 16 进制色生成 rgba，用于渐变与透明度控制 */
export function alpha(hex: string, opacity: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${opacity})`
}
