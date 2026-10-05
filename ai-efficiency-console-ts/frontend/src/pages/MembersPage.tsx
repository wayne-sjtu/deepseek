import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardHeader, Badge, LoadingBlock, EmptyState, ProgressBar, Skeleton } from '../components/Card'
import { Chart, areaGradient } from '../components/Chart'
import { DataTable, type Column } from '../components/DataTable'
import { PageShell } from '../components/Layout'
import { MetricCardGrid, chartAxisLabel, chartSplitLine, palette, type KpiItem } from '../components/MetricCard'
import { useScope } from '../lib/ScopeContext'
import { api } from '../lib/api'
import { COLORS, CHART_BASE } from '../lib/theme'
import {
  cx,
  downloadCsv,
  fmtCompact,
  fmtCredit,
  fmtDateTime,
  fmtInt,
  fmtPercent,
  fmtRelative,
  riskOf,
} from '../lib/format'
import type { MemberDataResponse, MemberDetailResponse, MemberRow } from '../lib/types'

type SortKey = keyof MemberRow | string

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'totalNewCodeLines', label: '新增代码行数' },
  { value: 'aiGenerateCodeLines', label: 'AI 生成代码行数' },
  { value: 'codeGenerateRateByLines', label: 'AI 代码占比' },
  { value: 'completionAcceptRateByLines', label: '补全采纳率' },
  { value: 'totalUsed', label: 'Credits 消耗' },
  { value: '__creditsPerKline', label: '千行成本（降序）' },
  { value: 'dialogCount', label: '对话次数' },
  { value: 'activeDays', label: '活跃天数' },
]

export default function MembersPage() {
  const { range, departmentIds, clearDepartments, departments, overview } = useScope()
  const [params, setParams] = useSearchParams()

  const deptFromUrl = params.get('dept')
  const detailId = params.get('member')
  const [keyword, setKeyword] = useState('')
  const [sortBy, setSortBy] = useState('totalNewCodeLines')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [minLines, setMinLines] = useState(0)
  const [data, setData] = useState<MemberDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const effectiveDeptIds = deptFromUrl ? [deptFromUrl] : departmentIds

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getMembers({
        timeRange: range,
        departmentIds: effectiveDeptIds,
        page: 1,
        pageSize: 200,
        sortBy,
        sortOrder,
        keyword,
      })
      .then((result) => {
        if (!alive) return
        setData(result)
        setError(null)
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [range, effectiveDeptIds.join(','), sortBy, sortOrder, keyword])

  /** mock 数据集的「今天」晚于系统时间，相对时间统一以参考日为基准 */
  const now = useMemo(() => {
    const reference = overview?.trend.at(-1)?.date
    return reference ? new Date(`${reference}T23:59:59`).getTime() : Date.now()
  }, [overview])

  const rows = useMemo(() => {
    const list = data?.members ?? []
    return minLines > 0 ? list.filter((row) => row.totalNewCodeLines >= minLines) : list
  }, [data, minLines])

  const summary = useMemo(() => {
    const list = data?.members ?? []
    if (!list.length) return null
    const totalLines = list.reduce((acc, row) => acc + row.totalNewCodeLines, 0)
    const totalAiLines = list.reduce((acc, row) => acc + row.aiGenerateCodeLines, 0)
    const totalCredit = list.reduce((acc, row) => acc + row.totalUsed, 0)
    const active = list.filter((row) => row.lastActiveTime).length
    const zeroCode = list.filter((row) => row.totalNewCodeLines === 0).length
    const highQuota = list.filter((row) => riskOf(row.__quotaUsageRate) === 'high').length
    const avgRate = totalLines ? (totalAiLines / totalLines) * 100 : 0
    return { totalLines, totalAiLines, totalCredit, active, zeroCode, highQuota, avgRate, count: list.length }
  }, [data])

  const kpis: KpiItem[] = useMemo(() => {
    if (!summary) return []
    const previous = data?.orgSummary.previousCredit ?? 0
    const delta = previous ? ((summary.totalCredit - previous) / previous) * 100 : null
    return [
      { key: 'members', label: '成员总数', value: summary.count, unit: '人', tone: 'brand', format: fmtInt, hint: '当前筛选范围内的成员数' },
      { key: 'active', label: '有活跃行为', value: summary.active, unit: '人', tone: 'cyan', format: fmtInt, hint: '窗口内产生过 AI 行为的成员' },
      { key: 'lines', label: '新增代码行合计', value: summary.totalLines, unit: '行', tone: 'violet', format: (v) => fmtCompact(v), hint: '全体成员新增代码总行数' },
      { key: 'airate', label: 'AI 代码占比', value: summary.avgRate, unit: '%', tone: 'mint', format: (v) => v.toFixed(1), hint: 'AI 生成行 ÷ 新增代码总行数（先求和再相除）' },
      { key: 'credit', label: 'Credits 消耗', value: summary.totalCredit, unit: 'credits', delta, higherIsBetter: false, tone: 'amber', format: (v) => fmtCompact(v), hint: '当前筛选范围的总消耗' },
      { key: 'risk', label: '额度超限风险', value: summary.highQuota, unit: '人', tone: 'rose', format: fmtInt, hint: '周期限量使用率 ≥ 90% 的成员数' },
      { key: 'zero', label: '零代码产出', value: summary.zeroCode, unit: '人', tone: 'slate', format: fmtInt, hint: '窗口内没有新增代码的成员，需要确认是否岗位不产出代码' },
    ]
  }, [summary, data])

  const columns: Array<Column<MemberRow>> = [
    {
      key: 'name',
      title: '成员',
      sortKey: 'memberName',
      render: (row) => (
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500/40 to-violet-500/30 text-[11px] font-semibold text-slate-100">
            {row.memberName.slice(0, 1)}
          </span>
          <div className="leading-tight">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setParams({ ...Object.fromEntries(params), member: row.memberId })
              }}
              className="font-medium text-slate-100 hover:text-brand-300"
            >
              {row.memberName}
            </button>
            <p className="text-[10px] text-slate-500">{row.primaryDepartmentName}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'lastActive',
      title: '最近活跃',
      sortKey: 'lastActiveTime',
      render: (row) => (
        <span title={fmtDateTime(row.lastActiveTime)} className={cx(!row.lastActiveTime && 'text-rose-400')}>
          {row.lastActiveTime ? fmtRelative(row.lastActiveTime, now) : '从未活跃'}
        </span>
      ),
    },
    {
      key: 'activeDays',
      title: '活跃天数',
      sortKey: 'activeDays',
      align: 'right',
      render: (row) => (
        <span>
          {row.activeDays}
          <span className="ml-1 text-[10px] text-slate-500">/{rangeDays()}</span>
        </span>
      ),
    },
    {
      key: 'lines',
      title: '新增代码行',
      sortKey: 'totalNewCodeLines',
      align: 'right',
      render: (row) => <span className="font-medium text-slate-100">{fmtInt(row.totalNewCodeLines)}</span>,
    },
    {
      key: 'ailines',
      title: 'AI 生成行',
      sortKey: 'aiGenerateCodeLines',
      align: 'right',
      render: (row) => <span className="text-cyan-400">{fmtInt(row.aiGenerateCodeLines)}</span>,
    },
    {
      key: 'airate',
      title: 'AI 代码占比',
      sortKey: 'codeGenerateRateByLines',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <span
            className={cx(
              'font-semibold',
              row.totalNewCodeLines === 0 ? 'text-slate-500' : row.codeGenerateRateByLines >= 80 ? 'text-mint-400' : row.codeGenerateRateByLines < 50 ? 'text-amber-400' : 'text-slate-200',
            )}
          >
            {row.totalNewCodeLines === 0 ? '—' : fmtPercent(row.codeGenerateRateByLines)}
          </span>
          <div className="w-14">
            <ProgressBar value={row.codeGenerateRateByLines} tone={row.codeGenerateRateByLines >= 80 ? 'mint' : 'brand'} height={4} />
          </div>
        </div>
      ),
    },
    {
      key: 'accept',
      title: '采纳率（按行）',
      sortKey: 'completionAcceptRateByLines',
      align: 'right',
      render: (row) => fmtPercent(row.completionAcceptRateByLines),
    },
    {
      key: 'dialog',
      title: '对话次数',
      sortKey: 'dialogCount',
      align: 'right',
      render: (row) => fmtInt(row.dialogCount),
    },
    {
      key: 'token',
      title: 'Token',
      sortKey: '__tokenUsage',
      align: 'right',
      render: (row) => fmtCompact(row.__tokenUsage),
    },
    {
      key: 'credit',
      title: 'Credits',
      sortKey: 'totalUsed',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-amber-300">{fmtCredit(row.totalUsed)}</span>
          <span className={cx('text-[10px]', row.__creditGrowthRate > 0 ? 'text-rose-400' : row.__creditGrowthRate < 0 ? 'text-mint-400' : 'text-slate-500')}>
            {row.__creditGrowthRate > 0 ? '↑' : row.__creditGrowthRate < 0 ? '↓' : '—'}
            {Math.abs(row.__creditGrowthRate).toFixed(0)}%
          </span>
        </div>
      ),
    },
    {
      key: 'unit',
      title: '千行成本',
      sortKey: '__creditsPerKline',
      align: 'right',
      render: (row) =>
        row.__creditsPerKline === null ? (
          <span className="text-slate-500">—</span>
        ) : (
          <span className={cx(row.__creditsPerKline > 1200 ? 'text-rose-400' : 'text-slate-300')}>{fmtCredit(row.__creditsPerKline)}</span>
        ),
    },
    {
      key: 'quota',
      title: '额度使用',
      sortKey: '__quotaUsageRate',
      align: 'right',
      render: (row) => {
        const risk = riskOf(row.__quotaUsageRate)
        return (
          <div className="flex items-center justify-end gap-2">
            <span className="text-[11px] text-slate-300">{row.__quotaUsageRate === null ? row.cycleLimitDisplay : fmtPercent(row.__quotaUsageRate)}</span>
            {row.__quotaUsageRate !== null && (
              <div className="w-12">
                <ProgressBar value={row.__quotaUsageRate} tone={risk === 'high' ? 'rose' : risk === 'medium' ? 'amber' : 'mint'} height={4} />
              </div>
            )}
          </div>
        )
      },
    },
    {
      key: 'action',
      title: '',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setParams({ ...Object.fromEntries(params), member: row.memberId })
          }}
          className="rounded-md bg-brand-500/15 px-2 py-1 text-[11px] text-brand-300 hover:bg-brand-500/25"
        >
          效能详情
        </button>
      ),
    },
  ]

  const leaders = useMemo(() => [...(data?.members ?? [])].sort((a, b) => b.aiGenerateCodeLines - a.aiGenerateCodeLines).slice(0, 3), [data])
  const attention = useMemo(
    () =>
      [...(data?.members ?? [])]
        .filter((row) => row.totalUsed > 0 && (row.__creditsPerKline ?? 0) > 1200)
        .sort((a, b) => (b.__creditsPerKline ?? 0) - (a.__creditsPerKline ?? 0))
        .slice(0, 3),
    [data],
  )
  const dormant = useMemo(() => (data?.members ?? []).filter((row) => !row.lastActiveTime).slice(0, 4), [data])

  function rangeDays(): number {
    return overview?.range.days ?? 30
  }

  return (
    <PageShell
      title="个人效能"
      description="逐人查看代码提交行数、AI 生成占比、补全采纳率与用量消耗，识别高效使用标杆与需要帮扶的成员。"
      actions={
        <>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                `个人效能_${range.startTime}_${range.endTime}.csv`,
                ['成员', '部门', '新增代码行', 'AI生成行', 'AI占比%', '采纳率%', '对话次数', 'Token', 'Credits', '千行成本', '额度使用率%', '最近活跃'],
                rows.map((row) => [
                  row.memberName, row.primaryDepartmentName, row.totalNewCodeLines, row.aiGenerateCodeLines,
                  row.codeGenerateRateByLines, row.completionAcceptRateByLines, row.dialogCount,
                  row.__tokenUsage, row.totalUsed, row.__creditsPerKline, row.__quotaUsageRate, row.lastActiveTime,
                ]),
              )
            }
            className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
          >
            导出 CSV（{rows.length} 人）
          </button>
        </>
      }
    >
      <MetricCardGrid items={kpis} columns={4} />

      <Card>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索成员 / 部门"
              className="w-52 rounded-lg bg-white/[0.05] px-3 py-2 text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none placeholder:text-slate-500 focus:ring-brand-500/50"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">排序</span>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none focus:ring-brand-500/50 [&>option]:bg-ink-800"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08]"
            >
              {sortOrder === 'desc' ? '降序 ↓' : '升序 ↑'}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">最小代码行</span>
            {[0, 500, 2000, 5000].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMinLines(value)}
                className={cx(
                  'rounded-lg px-2.5 py-2 text-xs ring-1 transition-colors',
                  minLines === value
                    ? 'bg-brand-500/90 text-white ring-brand-400/50'
                    : 'bg-white/[0.05] text-slate-300 ring-white/[0.08] hover:text-white',
                )}
              >
                {value === 0 ? '不限' : `≥ ${value}`}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">部门</span>
            <select
              value={deptFromUrl ?? (departmentIds.length === 1 ? departmentIds[0] : '')}
              onChange={(event) => {
                const value = event.target.value
                const next = { ...Object.fromEntries(params) }
                if (value) next.dept = value
                else delete next.dept
                setParams(next)
              }}
              className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none focus:ring-brand-500/50 [&>option]:bg-ink-800"
            >
              <option value="">全部部门</option>
              {departments.map((dept) => (
                <option key={dept.departmentId} value={dept.departmentId}>
                  {dept.departmentName}（{dept.memberCount}）
                </option>
              ))}
            </select>
            {(deptFromUrl || departmentIds.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  const next = { ...Object.fromEntries(params) }
                  delete next.dept
                  setParams(next)
                  clearDepartments()
                }}
                className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-[11px] text-slate-300 ring-1 ring-white/[0.08] hover:text-white"
              >
                重置
              </button>
            )}
          </div>

          <span className="ml-auto text-[11px] text-slate-500">
            命中 {rows.length} 人
            {departmentIds.length > 1 && ` · 全局部门筛选 ${departmentIds.length} 个`}
          </span>
        </div>

        <div className="mt-4">
          {loading && !data ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : error ? (
            <EmptyState title="加载失败" hint={error} />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.memberId}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSortChange={(key, order) => {
                setSortBy(key)
                setSortOrder(order)
              }}
              onRowClick={(row) => setParams({ ...Object.fromEntries(params), member: row.memberId })}
              maxHeight={620}
              empty={<span>当前条件下没有成员数据，试试放宽「最小代码行」或清空关键字</span>}
            />
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="AI 代码贡献 Top 3" subtitle="按 AI 生成代码行数排序，可作为最佳实践样板" />
          <ul className="space-y-3">
            {leaders.map((row, index) => (
              <li key={row.memberId} className="flex items-center gap-3">
                <span className={cx('flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-bold', index === 0 ? 'bg-amber-500/25 text-amber-300' : 'bg-white/[0.07] text-slate-300')}>
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-slate-100">
                    {row.memberName}
                    <span className="ml-1.5 text-[10px] text-slate-500">{row.primaryDepartmentName}</span>
                  </p>
                  <div className="mt-1">
                    <ProgressBar value={row.aiGenerateCodeLines} max={leaders[0]?.aiGenerateCodeLines || 1} tone="mint" height={4} />
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs text-mint-400">{fmtInt(row.aiGenerateCodeLines)}</p>
                  <p className="text-[10px] text-slate-500">{fmtPercent(row.codeGenerateRateByLines)}</p>
                </div>
              </li>
            ))}
            {leaders.length === 0 && <li className="py-4 text-center text-xs text-slate-500">暂无数据</li>}
          </ul>
        </Card>

        <Card>
          <CardHeader title="高消耗待复盘" subtitle="千行成本最高的成员：建议核查真实产出与使用方式" />
          <ul className="space-y-3">
            {attention.map((row) => (
              <li key={row.memberId} className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-500/20 text-[11px] text-rose-300">!</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-slate-100">
                    {row.memberName}
                    <span className="ml-1.5 text-[10px] text-slate-500">{row.primaryDepartmentName}</span>
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    AI 占比 {fmtPercent(row.codeGenerateRateByLines)} · 采纳率 {fmtPercent(row.completionAcceptRateByLines)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs text-rose-400">{fmtCredit(row.__creditsPerKline ?? 0)}</p>
                  <p className="text-[10px] text-slate-500">credits/千行</p>
                </div>
              </li>
            ))}
            {attention.length === 0 && <li className="py-4 text-center text-xs text-slate-500">暂无高消耗成员</li>}
          </ul>
        </Card>

        <Card>
          <CardHeader title="冷启动名单" subtitle="窗口内完全没有 AI 行为：确认是岗位不适用还是未完成开箱" />
          <ul className="space-y-2.5">
            {dormant.map((row) => (
              <li key={row.memberId} className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-slate-200">
                  {row.memberName}
                  <span className="ml-1.5 text-[10px] text-slate-500">{row.primaryDepartmentName}</span>
                </span>
                <Badge tone="neutral">零使用</Badge>
              </li>
            ))}
            {dormant.length === 0 && <li className="py-4 text-center text-xs text-slate-500">全员均有活跃行为</li>}
          </ul>
        </Card>
      </div>

      {detailId && <MemberDetailDrawer memberId={detailId} onClose={() => {
        const next = { ...Object.fromEntries(params) }
        delete next.member
        setParams(next)
      }} />}
    </PageShell>
  )
}

// ---------------------------------------------------------------------------
// 成员效能详情抽屉
// ---------------------------------------------------------------------------
function MemberDetailDrawer({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const { range, overview } = useScope()
  const now = overview?.trend.at(-1)?.date ? new Date(`${overview.trend.at(-1)!.date}T23:59:59`).getTime() : Date.now()
  const [detail, setDetail] = useState<MemberDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getMemberDetail(memberId, { timeRange: range })
      .then((result) => {
        if (alive) {
          setDetail(result)
          setError(null)
        }
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [memberId, range])

  const trendOption = useMemo(() => {
    if (!detail) return {}
    const dates = detail.trend.map((point) => point.date.slice(5))
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: { ...CHART_BASE.legend, data: ['AI 生成行', '人工编写行', 'AI 占比'] },
      xAxis: { type: 'category', data: dates, axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
      yAxis: [
        { type: 'value', axisLabel: chartAxisLabel, splitLine: chartSplitLine },
        { type: 'value', max: 100, axisLabel: { ...chartAxisLabel, formatter: '{value}%' }, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'AI 生成行',
          type: 'bar',
          stack: 'code',
          data: detail.trend.map((point) => point.aiCodeLines),
          itemStyle: { color: COLORS.brand, borderRadius: [0, 0, 2, 2] },
          barMaxWidth: 14,
        },
        {
          name: '人工编写行',
          type: 'bar',
          stack: 'code',
          data: detail.trend.map((point) => point.totalNewCodeLines - point.aiCodeLines),
          itemStyle: { color: 'rgba(100,116,139,0.5)', borderRadius: [2, 2, 0, 0] },
          barMaxWidth: 14,
        },
        {
          name: 'AI 占比',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: detail.trend.map((point) => point.aiCodeRate),
          lineStyle: { color: COLORS.mint, width: 1.8, type: 'dashed' },
        },
      ],
    }
  }, [detail])

  const usageOption = useMemo(() => {
    if (!detail) return {}
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: { ...CHART_BASE.legend, data: ['Credits 消耗', 'Token 用量'] },
      xAxis: { type: 'category', data: detail.trend.map((point) => point.date.slice(5)), axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
      yAxis: [
        { type: 'value', axisLabel: chartAxisLabel, splitLine: chartSplitLine },
        { type: 'value', axisLabel: { ...chartAxisLabel, formatter: (v: number) => fmtCompact(v, 0) }, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'Credits 消耗',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: detail.trend.map((point) => point.credit),
          lineStyle: { color: COLORS.amber, width: 2 },
          areaStyle: { color: areaGradient(COLORS.amber, 0.25, 0) },
        },
        {
          name: 'Token 用量',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: detail.trend.map((point) => point.tokenUsage),
          lineStyle: { color: COLORS.violet, width: 1.6 },
        },
      ],
    }
  }, [detail])

  const mixOption = useMemo(() => {
    if (!detail) return {}
    return {
      ...CHART_BASE,
      tooltip: { ...CHART_BASE.tooltip, trigger: 'item', formatter: '{b}<br/>Credits {c} ({d}%)' },
      legend: { ...CHART_BASE.legend, type: 'scroll', bottom: 0, top: undefined },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['50%', '44%'],
          itemStyle: { borderColor: '#0b1020', borderWidth: 2 },
          label: { color: COLORS.label, fontSize: 10, formatter: '{b}\n{d}%' },
          labelLine: { length: 6, length2: 6, lineStyle: { color: 'rgba(148,163,184,0.3)' } },
          data: detail.modelMix.map((item, index) => ({
            name: item.label,
            value: item.value,
            itemStyle: { color: palette(index) },
          })),
        },
      ],
    }
  }, [detail])

  const member = detail?.member
  // 部门均值取自 overview（含 AI 占比 / 采纳率 / 千行成本），用于个人与部门横向对照
  const deptAvg = overview?.departments.find((row) => row.departmentId === member?.primaryDepartmentId)

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="thin-scroll fixed right-0 top-0 z-40 flex h-full w-full max-w-[720px] flex-col overflow-y-auto border-l border-white/10 bg-ink-900/98 shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-white/[0.07] bg-ink-900/95 px-6 py-4 backdrop-blur">
          <div>
            {loading && !detail ? (
              <Skeleton className="h-6 w-40" />
            ) : (
              <>
                <h2 className="flex items-center gap-2 text-base font-semibold text-slate-50">
                  {member?.memberName}
                  <Badge tone="brand">{member?.primaryDepartmentName}</Badge>
                  {member && riskOf(member.__quotaUsageRate) === 'high' && <Badge tone="rose">额度超限风险</Badge>}
                </h2>
                <p className="mt-1 text-[11px] text-slate-400">
                  {detail?.profile.email} · 入职 {detail?.profile.joinedAt?.slice(0, 10)} · 主语言{' '}
                  {detail?.profile.primaryLanguage}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  统计窗口 {detail?.range.start} ~ {detail?.range.end}，环比对照 {detail?.range.previousStart} ~{' '}
                  {detail?.range.previousEnd}
                </p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => member && navigate(`/members?dept=${member.primaryDepartmentId}`)}
              className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
            >
              同部门成员
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
            >
              关闭
            </button>
          </div>
        </header>

        <div className="space-y-4 px-6 py-5">
          {error && <EmptyState title="详情加载失败" hint={error} />}
          {loading && !detail && <LoadingBlock />}
          {detail && member && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="新增代码行" value={fmtInt(member.totalNewCodeLines)} tone="text-slate-100" />
                <MiniStat label="AI 生成行" value={fmtInt(member.aiGenerateCodeLines)} tone="text-cyan-400" />
                <MiniStat
                  label="AI 代码占比"
                  value={member.totalNewCodeLines ? fmtPercent(member.codeGenerateRateByLines) : '—'}
                  tone="text-mint-400"
                  hint={deptAvg ? `部门均值 ${fmtPercent(deptAvg.aiCodeRate)}` : undefined}
                />
                <MiniStat
                  label="补全采纳率"
                  value={fmtPercent(member.completionAcceptRateByLines)}
                  tone="text-brand-300"
                  hint={deptAvg ? `部门均值 ${fmtPercent(deptAvg.acceptRateByLines)}` : undefined}
                />
                <MiniStat label="Credits 消耗" value={fmtCredit(member.totalUsed)} tone="text-amber-300" hint={`环比 ${member.__creditGrowthRate > 0 ? '+' : ''}${member.__creditGrowthRate.toFixed(1)}%`} />
                <MiniStat label="千行成本" value={member.__creditsPerKline === null ? '—' : fmtCredit(member.__creditsPerKline)} tone="text-slate-200" hint={deptAvg?.creditsPerKline ? `部门均值 ${fmtCredit(deptAvg.creditsPerKline)}` : undefined} />
                <MiniStat label="对话次数" value={fmtInt(member.dialogCount)} tone="text-slate-200" hint={`会话 ${fmtInt(member.__sessionCount)}`} />
                <MiniStat label="Token 用量" value={fmtCompact(member.__tokenUsage)} tone="text-violet-400" hint={`入 ${fmtCompact(member.__inputTokens)} / 出 ${fmtCompact(member.__outputTokens)}`} />
                <MiniStat label="活跃天数" value={`${member.activeDays} 天`} tone="text-slate-200" />
                <MiniStat label="最近活跃" value={fmtRelative(member.lastActiveTime, now)} tone="text-slate-200" />
                <MiniStat
                  label="额度使用率"
                  value={member.__quotaUsageRate === null ? member.cycleLimitDisplay : fmtPercent(member.__quotaUsageRate)}
                  tone={riskOf(member.__quotaUsageRate) === 'high' ? 'text-rose-400' : 'text-mint-400'}
                  hint={member.cycleLimit ? `限量 ${fmtInt(member.cycleLimit)}` : '不限量'}
                />
                <MiniStat label="日均 AI 行" value={fmtInt(member.__aiLinesPerActiveDay)} tone="text-slate-200" />
              </div>

              <Card>
                <CardHeader title="代码产出与 AI 占比趋势" subtitle="每日 AI 生成行 / 人工编写行堆叠，虚线为当日 AI 占比" />
                <Chart option={trendOption} height={240} />
              </Card>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="消耗趋势" subtitle="Credits 与 Token 用量走势" />
                  <Chart option={usageOption} height={220} />
                </Card>
                <Card>
                  <CardHeader title="模型消耗分布" subtitle="按模型拆分 Credits，判断是否用了「过重」的模型" />
                  <Chart option={mixOption} height={220} />
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="客户端分布" subtitle="按客户端拆分的 Credits 消耗" />
                  <MixTable items={detail.clientMix} />
                </Card>
                <Card>
                  <CardHeader title="语言分布" subtitle="按编程语言拆分的 Credits 与 AI 代码行" />
                  <MixTable items={detail.languageMix} showAiLines />
                </Card>
              </div>

              {deptAvg && (
                <Card>
                  <CardHeader title={`与「${deptAvg.departmentName}」均值对比`} subtitle="用于定位个人层面的差异来源" />
                  <div className="space-y-3">
                    <CompareBar label="AI 代码占比" self={member.totalNewCodeLines ? member.codeGenerateRateByLines : 0} peer={deptAvg.aiCodeRate} unit="%" />
                    <CompareBar label="补全采纳率" self={member.completionAcceptRateByLines} peer={deptAvg.acceptRateByLines} unit="%" />
                    <CompareBar
                      label="千行成本"
                      self={member.__creditsPerKline ?? 0}
                      peer={deptAvg.creditsPerKline ?? 0}
                      unit="credits"
                      lowerIsBetter
                    />
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  )
}

function MiniStat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={cx('mt-1 font-mono text-sm font-semibold', tone ?? 'text-slate-100')}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-500">{hint}</p>}
    </div>
  )
}

function MixTable({ items, showAiLines = false }: { items: MemberDetailResponse['modelMix']; showAiLines?: boolean }) {
  const total = items.reduce((acc, item) => acc + item.value, 0) || 1
  if (!items.length) return <p className="py-6 text-center text-xs text-slate-500">暂无数据</p>
  return (
    <ul className="space-y-2.5">
      {items.slice(0, 6).map((item, index) => (
        <li key={item.label}>
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 text-slate-200">
              <span className="h-2 w-2 rounded-sm" style={{ background: palette(index) }} />
              {item.label}
            </span>
            <span className="font-mono text-slate-300">
              {fmtCredit(item.value)}
              <span className="ml-1 text-[10px] text-slate-500">{fmtPercent((item.value / total) * 100)}</span>
            </span>
          </div>
          <div className="mt-1">
            <ProgressBar value={item.value} max={items[0].value} tone={index === 0 ? 'brand' : 'slate' as never} height={4} />
          </div>
          {showAiLines && item.extra?.aiCodeLines !== undefined && (
            <p className="mt-0.5 text-[10px] text-slate-500">AI 代码行 {fmtInt(item.extra.aiCodeLines)}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

function CompareBar({
  label,
  self,
  peer,
  unit,
  lowerIsBetter = false,
}: {
  label: string
  self: number
  peer: number
  unit: string
  lowerIsBetter?: boolean
}) {
  const max = Math.max(self, peer, 0.0001)
  const better = lowerIsBetter ? self <= peer : self >= peer
  const formatter = unit === '%' ? (value: number) => fmtPercent(value) : (value: number) => fmtCredit(value)
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className={cx('font-mono', better ? 'text-mint-400' : 'text-amber-400')}>
          {formatter(self)} <span className="text-slate-500">vs 部门 {formatter(peer)}</span>
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        <div className="flex items-center gap-2">
          <span className="w-8 text-[10px] text-slate-500">本人</span>
          <ProgressBar value={self} max={max} tone={better ? 'mint' : 'amber'} height={5} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 text-[10px] text-slate-500">部门</span>
          <ProgressBar value={peer} max={max} tone="brand" height={5} />
        </div>
      </div>
    </div>
  )
}

export type { SortKey }
