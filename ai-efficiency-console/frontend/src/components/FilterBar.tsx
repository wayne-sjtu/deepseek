import { useScope } from '../lib/ScopeContext'
import { cx, formatRange, rangeOfDays } from '../lib/format'
import { useDismissable } from '../lib/useDismissable'
import { Badge } from './Card'

const QUICK_RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
  { days: 180, label: '近 180 天' },
]

function previousRangeText(start: string, end: string): string {
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = new Date(`${end}T00:00:00`)
  const span = Math.round((endDate.getTime() - startDate.getTime()) / 86400_000) + 1
  const prevEnd = new Date(startDate)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevStart.getDate() - (span - 1))
  return `${formatRange({ startTime: prevStart.toISOString().slice(0, 10), endTime: prevEnd.toISOString().slice(0, 10) })}`
}

/**
 * 全局筛选条。
 * 所有分析页共用同一份 timeRange / departmentIds，切换页面时不会「口径漂移」。
 */
export function FilterBar() {
  const {
    days,
    range,
    setDays,
    setRange,
    departmentIds,
    departments,
    toggleDepartment,
    clearDepartments,
    refresh,
    lastUpdatedAt,
    loading,
    meta,
  } = useScope()
  const deptMenu = useDismissable<HTMLDivElement>()

  return (
    <div className="sticky top-0 z-20 -mx-6 mb-5 border-b border-white/[0.06] bg-ink-900/85 px-6 py-3 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* 快捷区间 */}
        <div className="flex items-center rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.06]">
          {QUICK_RANGES.map((item) => (
            <button
              key={item.days}
              type="button"
              onClick={() => setDays(item.days)}
              className={cx(
                'rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors',
                days === item.days && !isCustom(range, item.days)
                  ? 'bg-brand-500/90 text-white shadow-glow'
                  : 'text-slate-400 hover:text-slate-100',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 自定义区间 */}
        <div className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 ring-1 ring-white/[0.06]">
          <span className="text-[11px] text-slate-500">区间</span>
          <input
            type="date"
            value={range.startTime}
            max={range.endTime}
            onChange={(event) => setRange({ ...range, startTime: event.target.value })}
            className="w-[112px] bg-transparent font-mono text-[11px] text-slate-200 outline-none [color-scheme:dark]"
          />
          <span className="text-slate-600">→</span>
          <input
            type="date"
            value={range.endTime}
            min={range.startTime}
            onChange={(event) => setRange({ ...range, endTime: event.target.value })}
            className="w-[112px] bg-transparent font-mono text-[11px] text-slate-200 outline-none [color-scheme:dark]"
          />
        </div>

        {/* 部门筛选：ref 挂在外层容器上（同时包住触发器与面板），
            这样点触发器不会被当成「外部点击」而先收起再打开 */}
        <div className="relative" ref={deptMenu.ref}>
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={deptMenu.open}
            onClick={deptMenu.toggle}
            className={cx(
              'flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ring-1 transition-colors',
              departmentIds.length
                ? 'bg-brand-500/15 text-brand-300 ring-brand-500/40'
                : 'bg-white/[0.04] text-slate-300 ring-white/[0.06] hover:text-white',
            )}
          >
            部门范围
            <span className="rounded bg-white/10 px-1 text-[10px]">
              {departmentIds.length ? `${departmentIds.length} 个` : '全部'}
            </span>
            <span className="text-[9px] opacity-70">{deptMenu.open ? '▲' : '▼'}</span>
          </button>
          {deptMenu.open && (
            <div className="absolute left-0 top-full z-30 mt-1.5 w-64 animate-fade-up rounded-xl border border-white/10 bg-ink-800/98 p-2 shadow-card backdrop-blur-xl">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[11px] text-slate-400">按主部门过滤（可多选）</span>
                <button
                  type="button"
                  onClick={clearDepartments}
                  className="text-[11px] text-brand-300 hover:text-brand-400"
                >
                  清空
                </button>
              </div>
              <div className="max-h-72 overflow-auto">
                {departments.map((dept) => {
                  const checked = departmentIds.includes(dept.departmentId)
                  return (
                    <label
                      key={dept.departmentId}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-200 hover:bg-white/[0.05]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDepartment(dept.departmentId)}
                        className="h-3.5 w-3.5 accent-brand-500"
                      />
                      <span className="flex-1 truncate">{dept.departmentName}</span>
                      <span className="text-[10px] text-slate-500">{dept.memberCount} 人</span>
                    </label>
                  )
                })}
              </div>
              <div className="mt-1 border-t border-white/[0.07] px-2 pt-2">
                <button
                  type="button"
                  onClick={deptMenu.close}
                  className="w-full rounded-lg bg-brand-500/90 py-1.5 text-[11px] font-medium text-white hover:bg-brand-500"
                >
                  完成{departmentIds.length ? `（已选 ${departmentIds.length} 个）` : ''}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-slate-500 lg:inline">
            环比对照：{previousRangeText(range.startTime, range.endTime)}
          </span>
          {meta && (
            <Badge tone="violet" className="hidden md:inline-flex">
              Mock 数据 · {meta.referenceDay}
            </Badge>
          )}
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.1]"
          >
            <span className={cx('inline-block', loading && 'animate-spin')}>⟳</span>
            刷新
          </button>
          <span className="hidden text-[10px] text-slate-500 xl:inline">
            {new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        </div>
      </div>
    </div>
  )
}

function isCustom(range: { startTime: string; endTime: string }, days: number): boolean {
  const expected = rangeOfDays(days).current
  return expected.startTime !== range.startTime || expected.endTime !== range.endTime
}
