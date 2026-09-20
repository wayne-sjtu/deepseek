import type { DateRange } from './types'

/** 千分位整数 */
export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

/** 大数压缩：12,345 → 1.23万 / 12,345,678 → 1234.6万 */
export function fmtCompact(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(digits)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(digits)}万`
  return Math.round(value).toLocaleString('zh-CN')
}

/** Credits：整数部分千分位 + 2 位小数 */
export function fmtCredit(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export function fmtPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function fmtDelta(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function fmtRatio(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

/** 趋势色：考虑「越大越好 / 越小越好」 */
export function trendColor(growth: number | null | undefined, higherIsBetter = true): string {
  if (growth === null || growth === undefined || Number.isNaN(growth) || Math.abs(growth) < 0.05) {
    return 'text-slate-400'
  }
  const positive = growth > 0
  const good = positive === higherIsBetter
  return good ? 'text-mint-400' : 'text-rose-400'
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '从未活跃'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

/**
 * 相对时间：3 天前 / 2 小时前。
 * `now` 可显式传入基准时刻 —— mock 数据集的「今天」可能晚于真实系统时间，
 * 若不传基准会全部显示成「1 分钟前」，产生误导。
 */
export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '从未活跃'
  const diff = now - new Date(iso).getTime()
  if (Number.isNaN(diff)) return iso
  const day = 86400_000
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`
  if (diff < day) return `${Math.round(diff / 3600_000)} 小时前`
  if (diff < 30 * day) return `${Math.round(diff / day)} 天前`
  return fmtDate(iso)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// 时间区间
// ---------------------------------------------------------------------------
function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 相对「今天」生成区间；同时给出上一周期（用于环比） */
export function rangeOfDays(days: number, reference = new Date()): { current: DateRange; previous: DateRange } {
  const end = new Date(reference)
  const start = new Date(reference)
  start.setDate(start.getDate() - (days - 1))
  const prevEnd = new Date(start)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevStart.getDate() - (days - 1))
  return {
    current: { startTime: isoDay(start), endTime: isoDay(end) },
    previous: { startTime: isoDay(prevStart), endTime: isoDay(prevEnd) },
  }
}

export function shiftRange(range: DateRange, days: number): DateRange {
  const shift = (iso: string) => {
    const date = new Date(`${iso}T00:00:00`)
    date.setDate(date.getDate() + days)
    return isoDay(date)
  }
  return { startTime: shift(range.startTime), endTime: shift(range.endTime) }
}

export function rangeDays(range: DateRange): number {
  const start = new Date(`${range.startTime}T00:00:00`).getTime()
  const end = new Date(`${range.endTime}T00:00:00`).getTime()
  return Math.max(1, Math.round((end - start) / 86400_000) + 1)
}

export function formatRange(range: DateRange): string {
  return `${range.startTime.slice(5)} ~ ${range.endTime.slice(5)}`
}

// ---------------------------------------------------------------------------
// 风险等级
// ---------------------------------------------------------------------------
export type RiskLevel = 'high' | 'medium' | 'low' | 'unlimited'

export function riskOf(quotaUsageRate: number | null | undefined): RiskLevel {
  if (quotaUsageRate === null || quotaUsageRate === undefined) return 'unlimited'
  if (quotaUsageRate >= 90) return 'high'
  if (quotaUsageRate >= 70) return 'medium'
  return 'low'
}

export const RISK_META: Record<RiskLevel, { label: string; className: string }> = {
  high: { label: '超限风险', className: 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30' },
  medium: { label: '偏高', className: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30' },
  low: { label: '正常', className: 'bg-mint-500/15 text-mint-400 ring-1 ring-mint-500/30' },
  unlimited: { label: '不限量', className: 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30' },
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 简易 CSV 导出（前端本地生成，避免为导出单独开接口） */
type CsvCell = string | number | null | undefined

export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  const escape = (cell: CsvCell) => {
    const text = cell === null || cell === undefined ? '' : String(cell)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const content = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n')
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
