import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader, Badge, LoadingBlock, EmptyState, ProgressBar } from '../components/Card'
import { Chart, areaGradient } from '../components/Chart'
import { DataTable, type Column } from '../components/DataTable'
import { PageShell } from '../components/Layout'
import { useScope } from '../lib/ScopeContext'
import { COLORS, CHART_BASE } from '../lib/theme'
import { chartAxisLabel, chartSplitLine, palette } from '../components/MetricCard'
import { cx, fmtCompact, fmtCredit, fmtInt, fmtPercent, downloadCsv } from '../lib/format'
import type { DepartmentRow } from '../lib/types'

type Quadrant = 'scale' | 'costly' | 'efficient' | 'potential'

type BadgeTone = 'neutral' | 'brand' | 'mint' | 'amber' | 'rose' | 'violet' | 'cyan'

const QUADRANT_META: Record<Quadrant, { label: string; tone: BadgeTone; advice: string }> = {
  scale: { label: '规模双高', tone: 'brand', advice: '消耗与产出均高于中位数：属于 AI 深度使用部门，关注额度供给与稳定性' },
  costly: { label: '高耗低产', tone: 'rose', advice: '消耗高但 AI 代码占比低：建议复盘采纳率、模型选择与 prompt 质量' },
  efficient: { label: '低耗高产', tone: 'mint', advice: '消耗低但 AI 代码占比高：可作为最佳实践样板，横向推广使用方式' },
  potential: { label: '待激活', tone: 'neutral', advice: '消耗与产出均低于中位数：渗透率有提升空间，建议做入门培训与场景引导' },
}

export default function DepartmentsPage() {
  const { overview, loading, departmentIds, toggleDepartment, clearDepartments } = useScope()
  const navigate = useNavigate()

  const departments = overview?.departments ?? []

  const { medianCredit, medianRate, quadrantOf } = useMemo(() => {
    const credits = departments.map((d) => d.credit).sort((a, b) => a - b)
    const rates = departments.map((d) => d.aiCodeRate).sort((a, b) => a - b)
    const mid = (list: number[]) =>
      !list.length ? 0 : list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2
    const mCredit = mid(credits)
    const mRate = mid(rates)
    return {
      medianCredit: mCredit,
      medianRate: mRate,
      quadrantOf: (row: DepartmentRow): Quadrant => {
        const highCost = row.credit > mCredit
        const highYield = row.aiCodeRate > mRate
        if (highCost && highYield) return 'scale'
        if (highCost && !highYield) return 'costly'
        if (!highCost && highYield) return 'efficient'
        return 'potential'
      },
    }
  }, [departments])

  const bubbleOption = useMemo(() => {
    const maxMembers = Math.max(...departments.map((d) => d.memberCount), 1)
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 24, top: 34, bottom: 6, containLabel: true },
      tooltip: {
        ...CHART_BASE.tooltip,
        trigger: 'item',
        formatter: (params: any) => {
          const row = params.data.row as DepartmentRow
          return [
            `<b>${row.departmentName}</b>`,
            `Credits 消耗：${fmtCredit(row.credit)}`,
            `AI 代码占比：${fmtPercent(row.aiCodeRate)}`,
            `新增代码行：${fmtInt(row.totalNewCodeLines)}`,
            `千行成本：${row.creditsPerKline === null ? '—' : fmtCredit(row.creditsPerKline)}`,
            `活跃：${row.activeUserNum}/${row.memberCount} 人`,
          ].join('<br/>')
        },
      },
      xAxis: {
        type: 'value',
        name: 'AI 代码占比 %',
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: chartAxisLabel,
        axisLabel: { ...chartAxisLabel, formatter: '{value}%' },
        splitLine: chartSplitLine,
      },
      yAxis: {
        type: 'value',
        name: 'Credits 消耗',
        nameTextStyle: chartAxisLabel,
        axisLabel: { ...chartAxisLabel, formatter: (v: number) => fmtCompact(v, 0) },
        splitLine: chartSplitLine,
      },
      series: [
        {
          type: 'scatter',
          symbolSize: (data: any) => 18 + (data[2] / maxMembers) * 38,
          data: departments.map((d) => ({
            value: [d.aiCodeRate, d.credit, d.memberCount],
            row: d,
            itemStyle: {
              color: palette(departments.indexOf(d)),
              opacity: 0.85,
              borderColor: 'rgba(255,255,255,0.28)',
              borderWidth: 1,
            },
          })),
          label: {
            show: true,
            formatter: (params: any) => params.data.row.departmentName,
            position: 'top',
            color: '#cbd5e1',
            fontSize: 11,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' },
            label: { color: '#64748b', fontSize: 10, formatter: '{b}' },
            data: [
              { yAxis: medianCredit, name: '消耗中位数' },
              { xAxis: medianRate, name: '占比中位数' },
            ],
          },
        },
      ],
    }
  }, [departments, medianCredit, medianRate])

  const trendOption = useMemo(() => {
    const trend = overview?.trend ?? []
    const dates = trend.map((p) => p.date.slice(5))
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: { ...CHART_BASE.legend, data: ['日均消耗趋势（7 日滑动）'] },
      xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
      yAxis: { type: 'value', axisLabel: chartAxisLabel, splitLine: chartSplitLine },
      series: [
        {
          name: '日均消耗趋势（7 日滑动）',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: movingAverage(trend.map((p) => p.credit), 7),
          lineStyle: { width: 2, color: COLORS.cyan },
          areaStyle: { color: areaGradient(COLORS.cyan, 0.28, 0) },
        },
      ],
    }
  }, [overview])

  const columns: Array<Column<DepartmentRow>> = [
    {
      key: 'name',
      title: '部门',
      render: (row) => (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              navigate(`/members?dept=${row.departmentId}`)
            }}
            className="font-medium text-slate-100 hover:text-brand-300"
          >
            {row.departmentName}
          </button>
          <Badge tone={QUADRANT_META[quadrantOf(row)].tone}>{QUADRANT_META[quadrantOf(row)].label}</Badge>
        </div>
      ),
    },
    {
      key: 'active',
      title: '活跃/总数',
      sortKey: 'activeUserNum',
      align: 'right',
      render: (row) => (
        <span>
          {row.activeUserNum}
          <span className="text-slate-500">/{row.memberCount}</span>
          <span className="ml-1.5 text-[11px] text-slate-400">{fmtPercent(row.activeRate)}</span>
        </span>
      ),
    },
    { key: 'credit', title: 'Credits 消耗', sortKey: 'credit', align: 'right', render: (row) => <span className="text-amber-300">{fmtCredit(row.credit)}</span> },
    {
      key: 'growth',
      title: '消耗环比',
      sortKey: 'creditGrowthRate',
      align: 'right',
      render: (row) => (
        <span className={cx(row.creditGrowthRate > 0 ? 'text-rose-400' : row.creditGrowthRate < 0 ? 'text-mint-400' : 'text-slate-400')}>
          {row.creditGrowthRate > 0 ? '+' : ''}
          {row.creditGrowthRate.toFixed(1)}%
        </span>
      ),
    },
    { key: 'avg', title: '人均消耗', sortKey: 'avgCreditPerUser', align: 'right', render: (row) => fmtCredit(row.avgCreditPerUser) },
    { key: 'lines', title: '新增代码行', sortKey: 'totalNewCodeLines', align: 'right', render: (row) => fmtInt(row.totalNewCodeLines) },
    { key: 'ailines', title: 'AI 生成行', sortKey: 'aiCodeLines', align: 'right', render: (row) => fmtInt(row.aiCodeLines) },
    {
      key: 'airate',
      title: 'AI 占比',
      sortKey: 'aiCodeRate',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <span className={cx('font-semibold', row.aiCodeRate >= 85 ? 'text-mint-400' : row.aiCodeRate < 65 ? 'text-amber-400' : 'text-slate-200')}>
            {fmtPercent(row.aiCodeRate)}
          </span>
          <div className="w-14">
            <ProgressBar value={row.aiCodeRate} tone={row.aiCodeRate >= 85 ? 'mint' : 'brand'} height={4} />
          </div>
        </div>
      ),
    },
    { key: 'accept', title: '采纳率', sortKey: 'acceptRateByLines', align: 'right', render: (row) => fmtPercent(row.acceptRateByLines) },
    {
      key: 'peruser',
      title: '人均 AI 行',
      sortKey: 'aiLinesPerActiveUser',
      align: 'right',
      render: (row) => fmtInt(row.aiLinesPerActiveUser),
    },
    {
      key: 'unit',
      title: '千行成本',
      sortKey: 'creditsPerKline',
      align: 'right',
      render: (row) => (
        <span className={cx('font-medium', row.creditsPerKline !== null && row.creditsPerKline > 900 ? 'text-rose-400' : 'text-slate-300')}>
          {row.creditsPerKline === null ? '—' : fmtCredit(row.creditsPerKline)}
        </span>
      ),
    },
    {
      key: 'action',
      title: '操作',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              navigate(`/members?dept=${row.departmentId}`)
            }}
            className="rounded-md bg-brand-500/15 px-2 py-1 text-[11px] text-brand-300 hover:bg-brand-500/25"
          >
            成员明细
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              toggleDepartment(row.departmentId)
            }}
            className={cx(
              'rounded-md px-2 py-1 text-[11px] ring-1',
              departmentIds.includes(row.departmentId)
                ? 'bg-white/[0.08] text-slate-200 ring-white/15'
                : 'bg-transparent text-slate-400 ring-white/10 hover:text-slate-200',
            )}
          >
            {departmentIds.includes(row.departmentId) ? '移出对比' : '加入对比'}
          </button>
        </div>
      ),
    },
  ]

  return (
    <PageShell
      title="部门效能"
      description="横向对比各部门的 AI 消耗、代码产出与 AI 贡献占比，定位需要复盘的部门；点击部门可下钻到成员级明细。"
      actions={
        <>
          {departmentIds.length > 0 && (
            <button
              type="button"
              onClick={clearDepartments}
              className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
            >
              清除部门筛选（{departmentIds.length}）
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                '部门效能对比.csv',
                ['部门', '人数', '活跃人数', '活跃率%', 'Credits消耗', '消耗环比%', '消耗占比%', '人均消耗', '新增代码行', 'AI生成行', 'AI占比%', '采纳率%', '人均AI行', '千行成本'],
                departments.map((d) => [
                  d.departmentName, d.memberCount, d.activeUserNum, d.activeRate, d.credit,
                  d.creditGrowthRate, d.creditShare, d.avgCreditPerUser, d.totalNewCodeLines,
                  d.aiCodeLines, d.aiCodeRate, d.acceptRateByLines, d.aiLinesPerActiveUser, d.creditsPerKline,
                ]),
              )
            }
            className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
          >
            导出 CSV
          </button>
        </>
      }
    >
      {!overview && loading ? (
        <LoadingBlock />
      ) : !overview || departments.length === 0 ? (
        <EmptyState title="没有匹配的部门数据" hint="请调整时间范围或部门筛选" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader
                title="消耗 - 产出四象限"
                subtitle="横轴 AI 代码占比，纵轴 Credits 消耗，气泡大小 = 部门人数；虚线为中位数分界"
                extra={<Badge tone="brand">右上角 = 规模双高</Badge>}
              />
              <Chart option={bubbleOption} height={330} />
              <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                {(Object.keys(QUADRANT_META) as Quadrant[]).map((key) => {
                  const rows = departments.filter((d) => quadrantOf(d) === key)
                  return (
                    <div key={key} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
                      <div className="flex items-center justify-between">
                        <Badge tone={QUADRANT_META[key].tone}>{QUADRANT_META[key].label}</Badge>
                        <span className="font-mono text-xs text-slate-400">{rows.length}</span>
                      </div>
                      <p className="mt-1.5 truncate text-[11px] text-slate-300" title={rows.map((r) => r.departmentName).join('、')}>
                        {rows.length ? rows.map((r) => r.departmentName).join('、') : '无'}
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{QUADRANT_META[key].advice}</p>
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card>
              <CardHeader title="消耗趋势" subtitle="每日 Credits 消耗的 7 日滑动平均，抹平周末波动" />
              <Chart option={trendOption} height={330} />
              <ul className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3 text-[11px] text-slate-400">
                <li>
                  窗口总消耗 <span className="font-mono text-amber-300">{fmtCredit(overview.org.credit)}</span> credits
                </li>
                <li>
                  日均消耗{' '}
                  <span className="font-mono text-slate-200">
                    {fmtCredit(overview.org.credit / Math.max(1, overview.range.days))}
                  </span>{' '}
                  credits
                </li>
                <li>
                  人均消耗{' '}
                  <span className="font-mono text-slate-200">{fmtCredit(overview.org.avgCreditsPerActiveUser)}</span> credits
                </li>
              </ul>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="部门明细表"
              subtitle={`共 ${departments.length} 个部门；消耗环比对标上一同等长度周期。稳定性指标（失败率 / 时延）仅企业级可获取，见「指标口径 → 数据来源与可获取性」`}
              extra={<Badge tone={departmentIds.length ? 'brand' : 'neutral'}>{departmentIds.length ? `已选 ${departmentIds.length} 个部门` : '全部部门'}</Badge>}
            />
            <DataTable
              columns={columns}
              rows={departments}
              rowKey={(row) => row.departmentId}
              localSort
              defaultSort={{ key: 'credit', order: 'desc' }}
              maxHeight={520}
            />
          </Card>
        </>
      )}
    </PageShell>
  )
}

function movingAverage(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1)
    const slice = values.slice(start, index + 1)
    const sum = slice.reduce((acc, value) => acc + value, 0)
    return Number((sum / slice.length).toFixed(2))
  })
}
