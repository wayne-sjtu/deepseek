import type { ReactNode } from 'react'
import { Chart, areaGradient } from './Chart'
import { Card } from './Card'
import { COLORS, CHART_BASE, SERIES_PALETTE, AXIS_LABEL, SPLIT_LINE } from '../lib/theme'
import { fmtCompact, fmtInt } from '../lib/format'

export interface KpiItem {
  key: string
  label: string
  value: number
  unit?: string
  /** 环比；null 表示无对比基数。默认按百分比解释 */
  delta?: number | null
  /**
   * 环比的单位口径：
   * - 'percent'（默认）数值本身的相对变化率（%）
   * - 'point' 比率类指标的变化，按百分点（pp）解读，避免把 81.2% - 80.4% 说成 +0.8%
   */
  deltaUnit?: 'percent' | 'point'
  /** 环比是否越大越好（消耗类指标为 false） */
  higherIsBetter?: boolean
  /** 主数值格式化方式 */
  format?: (value: number) => string
  hint?: string
  tone?: keyof typeof TONE_TEXT
  spark?: number[]
}

const TONE_TEXT = {
  brand: 'text-brand-300',
  cyan: 'text-cyan-400',
  mint: 'text-mint-400',
  amber: 'text-amber-400',
  rose: 'text-rose-400',
  violet: 'text-violet-400',
  slate: 'text-slate-200',
} as const

const TONE_HEX = {
  brand: COLORS.brandSoft,
  cyan: COLORS.cyan,
  mint: COLORS.mint,
  amber: COLORS.amber,
  rose: COLORS.rose,
  violet: COLORS.violet,
  slate: COLORS.slate,
} as const

function DeltaTag({
  delta,
  higherIsBetter = true,
  unit = 'percent',
}: {
  delta: number
  higherIsBetter?: boolean
  unit?: 'percent' | 'point'
}) {
  const stable = Math.abs(delta) < 0.05
  const up = delta > 0
  const good = up === higherIsBetter
  const tone = stable ? 'text-slate-400' : good ? 'text-mint-400' : 'text-rose-400'
  const bg = stable
    ? 'bg-slate-500/12'
    : good
      ? 'bg-mint-500/12'
      : 'bg-rose-500/12'
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tone} ${bg}`}>
      {stable ? '—' : up ? '▲' : '▼'}
      {unit === 'point' ? `${Math.abs(delta).toFixed(1)}pp` : `${Math.abs(delta).toFixed(1)}%`}
    </span>
  )
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const option = {
    ...CHART_BASE,
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: data.map((_, index) => index) },
    yAxis: { type: 'value', show: false, min: 'dataMin', max: 'dataMax' },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        data,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.6, color },
        areaStyle: { color: areaGradient(color, 0.4, 0) },
      },
    ],
  }
  return <Chart option={option} height={34} animate={false} />
}

/**
 * KPI 卡片：大数值 + 环比 + 迷你趋势线。
 * 消耗类指标默认「降低为好」，因此 higherIsBetter=false 时上涨显示为红色。
 */
export function MetricCard({ item }: { item: KpiItem }) {
  const tone = item.tone ?? 'brand'
  const formatter = item.format ?? ((value: number) => fmtInt(value))
  return (
    <Card className="relative overflow-hidden transition-colors hover:border-brand-500/25">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-xs font-medium text-slate-400">{item.label}</p>
            {item.hint && (
              <span className="group relative cursor-help text-[10px] text-slate-500" title={item.hint}>
                ⓘ
              </span>
            )}
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className={`font-mono text-[26px] font-semibold leading-none tracking-tight ${TONE_TEXT[tone]}`}>
              {formatter(item.value)}
            </span>
            {item.unit && <span className="text-xs text-slate-400">{item.unit}</span>}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-500">
            <span>环比</span>
            {item.delta === null || item.delta === undefined ? (
              <span className="text-slate-500">无对比数据</span>
            ) : (
              <DeltaTag delta={item.delta} higherIsBetter={item.higherIsBetter} unit={item.deltaUnit} />
            )}
          </div>
        </div>
        {item.spark && item.spark.length > 1 && (
          <div className="w-20 shrink-0 opacity-90">
            <Sparkline data={item.spark} color={TONE_HEX[tone]} />
          </div>
        )}
      </div>
    </Card>
  )
}

export function MetricCardGrid({ items, columns = 4 }: { items: KpiItem[]; columns?: 3 | 4 | 5 | 6 }) {
  const cols: Record<number, string> = {
    3: 'sm:grid-cols-2 xl:grid-cols-3',
    4: 'sm:grid-cols-2 xl:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
    6: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6',
  }
  return (
    <div className={`grid grid-cols-1 gap-3 ${cols[columns]}`}>
      {items.map((item) => (
        <MetricCard key={item.key} item={item} />
      ))}
    </div>
  )
}

/** 图表色板（供页面绘制多系列图表时统一取色） */
export const palette = (index: number): string => SERIES_PALETTE[index % SERIES_PALETTE.length]

export const chartAxisLabel = AXIS_LABEL
export const chartSplitLine = SPLIT_LINE

/** 空数据占位：避免 ECharts 空白画布无提示 */
export function chartEmptyOption(title = '暂无数据', hint = '请调整时间范围或部门筛选'): unknown {
  return {
    title: {
      text: title,
      subtext: hint,
      left: 'center',
      top: '42%',
      textStyle: { color: '#64748b', fontSize: 13, fontWeight: 'normal' },
      subtextStyle: { color: '#475569', fontSize: 11 },
    },
  }
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-3 mt-1 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
        <span className="h-3.5 w-1 rounded-full bg-brand-500" />
        {children}
      </h2>
      {extra}
    </div>
  )
}

export { fmtCompact }
