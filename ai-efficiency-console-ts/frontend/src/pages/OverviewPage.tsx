import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader, Badge, LoadingBlock, EmptyState, ProgressBar } from '../components/Card'
import { MetricCardGrid, palette, chartAxisLabel, chartSplitLine, type KpiItem } from '../components/MetricCard'
import { Chart, areaGradient } from '../components/Chart'
import { DataTable, type Column } from '../components/DataTable'
import { PageShell } from '../components/Layout'
import { useScope } from '../lib/ScopeContext'
import { COLORS, CHART_BASE } from '../lib/theme'
import {
  cx,
  fmtCompact,
  fmtCredit,
  fmtInt,
  fmtPercent,
  downloadCsv,
  formatRange,
} from '../lib/format'
import type { DepartmentRow } from '../lib/types'

export default function OverviewPage() {
  const { overview, loading, range, departments: deptOptions } = useScope()
  const navigate = useNavigate()

  const org = overview?.org
  const trend = overview?.trend ?? []
  const departments = useMemo(
    () => [...(overview?.departments ?? [])].sort((a, b) => b.credit - a.credit),
    [overview],
  )

  const kpis: KpiItem[] = useMemo(() => {
    if (!org) return []
    const prevCredit = org.previous.credit ?? null
    const creditDelta = prevCredit ? ((org.credit - prevCredit) / prevCredit) * 100 : null
    const aiSpark = trend.slice(-14).map((p) => p.aiCodeLines)
    const creditSpark = trend.slice(-14).map((p) => p.credit)
    const activeSpark = trend.slice(-14).map((p) => p.activeUserNum)
    return [
      {
        key: 'credit',
        label: 'AI 用量消耗（Credits）',
        value: org.credit,
        unit: 'credits',
        delta: creditDelta,
        higherIsBetter: false,
        tone: 'amber',
        format: (v) => fmtCompact(v),
        spark: creditSpark,
        hint: '周期内全部成员的 Credits 聚合消耗，含对话、补全与代码生成',
      },
      {
        key: 'activeUsers',
        label: '活跃使用人数',
        value: org.activeUserNum,
        unit: `/ ${org.memberCount} 人`,
        delta:
          org.previous.activeUserNum === null || org.previous.activeUserNum === undefined
            ? null
            : ((org.activeUserNum - org.previous.activeUserNum) / org.previous.activeUserNum) * 100,
        tone: 'brand',
        format: (v) => fmtInt(v),
        spark: activeSpark,
        hint: '窗口内产生过任意 AI 行为（对话 / 补全 / 生成）的去重成员数',
      },
      {
        key: 'lines',
        label: '新增代码行数',
        value: org.totalNewCodeLines,
        unit: '行',
        delta: org.previous.totalNewCodeLines
          ? ((org.totalNewCodeLines - (org.previous.totalNewCodeLines ?? 0)) /
              (org.previous.totalNewCodeLines ?? 1)) *
            100
          : null,
        tone: 'cyan',
        format: (v) => fmtCompact(v),
        spark: trend.slice(-14).map((p) => p.totalNewCodeLines),
        hint: '统计口径：新增代码总行数（totalNewCodeLines）',
      },
      {
        key: 'ai-lines',
        label: 'AI 生成代码行数',
        value: org.aiCodeLines,
        unit: '行',
        delta: org.previous.aiCodeLines
          ? ((org.aiCodeLines - (org.previous.aiCodeLines ?? 0)) / (org.previous.aiCodeLines ?? 1)) * 100
          : null,
        tone: 'mint',
        format: (v) => fmtCompact(v),
        spark: aiSpark,
        hint: 'AI 参与生成并被保留的代码行数（aiGenerateCodeLines）',
      },
      {
        key: 'ai-rate',
        label: 'AI 代码占比',
        value: org.codeGenerateRateByLines ?? 0,
        unit: '%',
        delta:
          org.previous.codeGenerateRateByLines === null || org.previous.codeGenerateRateByLines === undefined
            ? null
            : (org.codeGenerateRateByLines ?? 0) - org.previous.codeGenerateRateByLines,
        deltaUnit: 'point',
        tone: 'violet',
        format: (v) => v.toFixed(1),
        hint: 'AI 生成行数 ÷ 新增代码总行数（codeGenerateRateByLines），环比按百分点（pp）展示',
      },
      {
        key: 'accept-rate',
        label: '补全采纳率（按行）',
        value: org.completionAcceptRateByLines ?? 0,
        unit: '%',
        delta: null,
        tone: 'brand',
        format: (v) => v.toFixed(1),
        hint: '补全采纳行数 ÷ 补全生成行数',
      },
      {
        key: 'token',
        label: 'Token 消耗',
        value: org.tokenUsage,
        unit: 'tokens',
        delta: org.previous.tokenUsage
          ? ((org.tokenUsage - (org.previous.tokenUsage ?? 0)) / (org.previous.tokenUsage ?? 1)) * 100
          : null,
        higherIsBetter: false,
        tone: 'slate',
        format: (v) => fmtCompact(v),
        hint: '输入 token + 输出 token；可用于核对 Credits 消耗是否异常',
      },
      {
        key: 'dialog',
        label: '对话次数',
        value: org.dialogCount,
        unit: '次',
        delta: org.previous.dialogCount
          ? ((org.dialogCount - (org.previous.dialogCount ?? 0)) / (org.previous.dialogCount ?? 1)) * 100
          : null,
        tone: 'slate',
        format: (v) => fmtCompact(v),
        hint: 'Ask / Craft / Agent 等全部对话能力的请求次数',
      },
    ]
  }, [org, trend])

  // 消耗-产出画像：识别「高消耗低产出」部门
  const insights = useMemo(() => {
    if (departments.length < 2) return []
    const byCredit = [...departments].sort((a, b) => b.credit - a.credit)
    const medianCredit =
      byCredit.length % 2
        ? byCredit[(byCredit.length - 1) / 2].credit
        : (byCredit[byCredit.length / 2 - 1].credit + byCredit[byCredit.length / 2].credit) / 2
    const aiRates = [...departments].map((d) => d.aiCodeRate).sort((a, b) => a - b)
    const medianAiRate = aiRates[Math.floor(aiRates.length / 2)]
    return departments.map((dept) => {
      const highCost = dept.credit > medianCredit
      const highYield = dept.aiCodeRate > medianAiRate
      const type = highCost && highYield
        ? 'scale'
        : highCost && !highYield
          ? 'costly'
          : !highCost && highYield
            ? 'efficient'
            : 'potential'
      return { dept, type }
    })
  }, [departments])

  const costly = insights.filter((i) => i.type === 'costly').map((i) => i.dept)
  const efficient = insights.filter((i) => i.type === 'efficient').map((i) => i.dept)

  const columns: Array<Column<DepartmentRow>> = [
    {
      key: 'name',
      title: '部门',
      render: (row) => (
        <button
          type="button"
          className="text-left font-medium text-slate-100 hover:text-brand-300"
          onClick={(event) => {
            event.stopPropagation()
            navigate(`/members?dept=${row.departmentId}`)
          }}
        >
          {row.departmentName}
          <span className="ml-1.5 text-[10px] text-slate-500">{row.memberCount} 人</span>
        </button>
      ),
    },
    {
      key: 'credit',
      title: 'Credits 消耗',
      sortKey: 'credit',
      align: 'right',
      render: (row) => <span className="text-amber-300">{fmtCredit(row.credit)}</span>,
    },
    {
      key: 'share',
      title: '消耗占比',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <span className="w-10 text-right text-slate-300">{fmtPercent(row.creditShare)}</span>
          <div className="w-16">
            <ProgressBar value={row.creditShare} tone="amber" height={4} />
          </div>
        </div>
      ),
    },
    {
      key: 'avg',
      title: '人均消耗',
      sortKey: 'avgCreditPerUser',
      align: 'right',
      render: (row) => fmtCredit(row.avgCreditPerUser),
    },
    {
      key: 'lines',
      title: '新增代码行',
      sortKey: 'totalNewCodeLines',
      align: 'right',
      render: (row) => fmtInt(row.totalNewCodeLines),
    },
    {
      key: 'ai-lines',
      title: 'AI 生成行',
      sortKey: 'aiCodeLines',
      align: 'right',
      render: (row) => fmtInt(row.aiCodeLines),
    },
    {
      key: 'ai-rate',
      title: 'AI 占比',
      sortKey: 'aiCodeRate',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <span className={cx('font-semibold', row.aiCodeRate >= 80 ? 'text-mint-400' : 'text-slate-200')}>
            {fmtPercent(row.aiCodeRate)}
          </span>
          <div className="w-14">
            <ProgressBar value={row.aiCodeRate} tone={row.aiCodeRate >= 80 ? 'mint' : 'brand'} height={4} />
          </div>
        </div>
      ),
    },
    {
      key: 'unit-cost',
      title: '千行成本',
      sortKey: 'creditsPerKline',
      align: 'right',
      tooltip: 'Credits 消耗 ÷ (新增代码行数 / 1000)：越低代表单位产出越省',
      render: (row) => (
        <span className={cx(row.creditsPerKline !== null && row.creditsPerKline > 900 ? 'text-rose-400' : 'text-slate-300')}>
          {row.creditsPerKline === null ? '—' : fmtCredit(row.creditsPerKline)}
        </span>
      ),
    },
    {
      key: 'accept',
      title: '采纳率',
      sortKey: 'acceptRateByLines',
      align: 'right',
      render: (row) => fmtPercent(row.acceptRateByLines),
    },
  ]

  const creditTrendOption = useMemo(() => {
    const dates = trend.map((p) => p.date.slice(5))
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: { ...CHART_BASE.legend, data: ['Credits 消耗', 'AI 代码占比'] },
      xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
      yAxis: [
        { type: 'value', name: 'Credits', nameTextStyle: chartAxisLabel, axisLabel: chartAxisLabel, splitLine: chartSplitLine },
        { type: 'value', name: '占比 %', nameTextStyle: chartAxisLabel, axisLabel: { ...chartAxisLabel, formatter: '{value}%' }, splitLine: { show: false }, max: 100 },
      ],
      series: [
        {
          name: 'Credits 消耗',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: trend.map((p) => p.credit),
          lineStyle: { width: 2, color: COLORS.amber },
          areaStyle: { color: areaGradient(COLORS.amber, 0.3, 0) },
        },
        {
          name: 'AI 代码占比',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: trend.map((p) => p.aiCodeRate),
          lineStyle: { width: 2, color: COLORS.mint, type: 'dashed' },
        },
      ],
    }
  }, [trend])

  const codeTrendOption = useMemo(() => {
    const dates = trend.map((p) => p.date.slice(5))
    return {
      ...CHART_BASE,
      grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: { ...CHART_BASE.legend, data: ['新增代码总行数', 'AI 生成代码行数'] },
      xAxis: { type: 'category', data: dates, axisLabel: chartAxisLabel, axisLine: { lineStyle: { color: COLORS.axis } } },
      yAxis: { type: 'value', axisLabel: { ...chartAxisLabel, formatter: (v: number) => fmtCompact(v, 0) }, splitLine: chartSplitLine },
      series: [
        {
          name: '新增代码总行数',
          type: 'bar',
          stack: 'lines',
          data: trend.map((p) => p.totalNewCodeLines - p.aiCodeLines),
          itemStyle: { color: 'rgba(100,116,139,0.55)', borderRadius: [0, 0, 3, 3] },
          barMaxWidth: 18,
        },
        {
          name: 'AI 生成代码行数',
          type: 'bar',
          stack: 'lines',
          data: trend.map((p) => p.aiCodeLines),
          itemStyle: { color: COLORS.brand, borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 18,
        },
      ],
    }
  }, [trend])

  const shareOption = useMemo(() => {
    const top = departments.slice(0, 8)
    return {
      ...CHART_BASE,
      tooltip: { ...CHART_BASE.tooltip, trigger: 'item', formatter: '{b}<br/>Credits {c} ({d}%)' },
      legend: { ...CHART_BASE.legend, type: 'scroll', bottom: 0, top: undefined },
      series: [
        {
          type: 'pie',
          radius: ['46%', '72%'],
          center: ['50%', '46%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#0b1020', borderWidth: 2 },
          label: { color: COLORS.label, fontSize: 11, formatter: '{b}\n{d}%' },
          labelLine: { lineStyle: { color: 'rgba(148,163,184,0.35)' } },
          data: top.map((dept, index) => ({
            name: dept.departmentName,
            value: Number(dept.credit.toFixed(2)),
            itemStyle: { color: palette(index) },
          })),
        },
      ],
    }
  }, [departments])

  const resourceItems = org?.resourceItems ?? []
  const quotaCycle = org?.quotaCycle
  const seatTotal = org?.seatTotal ?? 0
  const seatUsed = org?.seatUsed ?? 0
  const seatRate = seatTotal ? (seatUsed / seatTotal) * 100 : 0

  return (
    <PageShell
      title="用量总览"
      description={`统计窗口 ${range.startTime} ~ ${range.endTime}（${overview?.range.days ?? 0} 天）${
        overview ? `，环比对照 ${overview.range.previousStart} ~ ${overview.range.previousEnd}` : ''
      }`}
      actions={
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              `部门效能_${range.startTime}_${range.endTime}.csv`,
              ['部门', '人数', '活跃人数', 'Credits消耗', '消耗占比%', '人均消耗', '新增代码行', 'AI生成行', 'AI占比%', '采纳率%', '千行成本'],
              departments.map((d) => [
                d.departmentName,
                d.memberCount,
                d.activeUserNum,
                d.credit,
                d.creditShare,
                d.avgCreditPerUser,
                d.totalNewCodeLines,
                d.aiCodeLines,
                d.aiCodeRate,
                d.acceptRateByLines,
                d.creditsPerKline,
              ]),
            )
          }
          className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
        >
          导出部门明细 CSV
        </button>
      }
    >
      {!overview && loading ? (
        <LoadingBlock label="正在加载效能数据…" />
      ) : !overview ? (
        <EmptyState title="暂无数据" hint="请确认后端 Mock 服务已启动，或调整筛选条件" />
      ) : (
        <>
          <MetricCardGrid items={kpis} columns={4} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader
                title="消耗与 AI 渗透趋势"
                subtitle="左轴：每日 Credits 消耗；右轴：当日 AI 代码占比。两者背离时说明「钱花了但没转成代码产出」"
                extra={<Badge tone="amber">Credits 为成本口径</Badge>}
              />
              <Chart option={creditTrendOption} height={280} />
            </Card>
            <Card>
              <CardHeader title="部门消耗结构" subtitle="Credits 消耗 Top 8 部门占比" />
              <Chart option={shareOption} height={280} />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader
                title="代码产出结构"
                subtitle="堆叠柱：AI 生成行（蓝）与人工编写行（灰）；可直接看出 AI 对代码增量的贡献重心"
              />
              <Chart option={codeTrendOption} height={260} />
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="席位与额度" subtitle="License 席位与积分余额健康度" />
                <div className="space-y-4">
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="text-xs text-slate-400">席位使用率</span>
                      <span className="font-mono text-sm text-slate-100">
                        {seatUsed}/{seatTotal}
                        <span className="ml-1 text-[11px] text-slate-400">{fmtPercent(seatRate)}</span>
                      </span>
                    </div>
                    <ProgressBar value={seatRate} tone={seatRate > 92 ? 'rose' : 'brand'} />
                  </div>
                  {resourceItems
                    .filter((item) => item.resourceType === 'credit')
                    .map((item) => (
                      <div key={item.resourceType}>
                        <div className="mb-1.5 flex items-baseline justify-between">
                          <span className="text-xs text-slate-400">积分余额</span>
                          <span className="font-mono text-sm text-slate-100">
                            {fmtCompact(item.remaining)}
                            <span className="ml-1 text-[11px] text-slate-400">
                              剩 {fmtPercent(item.remainingRatio * 100)}
                            </span>
                          </span>
                        </div>
                        <ProgressBar
                          value={item.remainingRatio * 100}
                          tone={item.remainingRatio < 0.15 ? 'rose' : item.remainingRatio < 0.3 ? 'amber' : 'mint'}
                        />
                        <p className="mt-1.5 text-[10px] text-slate-500">
                          当前有效期总量 {fmtCompact(item.total)}，已用 {fmtCompact(item.used)}
                        </p>
                      </div>
                    ))}
                  {quotaCycle?.cycleStart && (
                    <p className="border-t border-white/[0.06] pt-3 text-[10px] leading-relaxed text-slate-500">
                      额度周期：{quotaCycle.cycleMode === 'natural_month' ? '自然月' : '订阅生效日切片'}
                      <br />
                      {quotaCycle.cycleStart.slice(0, 10)} ~ {quotaCycle.cycleEnd.slice(0, 10)}（下一次{' '}
                      {quotaCycle.nextCycleStart.slice(0, 10)} 重置）
                    </p>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader title="消耗-产出画像" subtitle="以中位数为分界：识别需要重点复盘的部门" />
                <ul className="space-y-2.5 text-xs">
                  <li className="flex items-start gap-2">
                    <Badge tone="rose" className="mt-0.5 shrink-0">高耗低产</Badge>
                    <span className="text-slate-300">
                      {costly.length ? costly.map((d) => d.departmentName).join('、') : '无'}
                      {costly.length > 0 && (
                        <span className="ml-1 text-slate-500">
                          千行成本高于大盘（{costly.length} 个）
                        </span>
                      )}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Badge tone="mint" className="mt-0.5 shrink-0">低耗高产</Badge>
                    <span className="text-slate-300">
                      {efficient.length ? efficient.map((d) => d.departmentName).join('、') : '无'}
                    </span>
                  </li>
                  <li className="border-t border-white/[0.06] pt-2.5 text-[10px] leading-relaxed text-slate-500">
                    口径：消耗高于各部门中位数且 AI 代码占比低于中位数 → 高耗低产；
                    反之则为低耗高产。建议对前者做用量明细与采纳率复盘。
                  </li>
                </ul>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader
              title="部门用量排行"
              subtitle={`窗口 ${formatRange({ startTime: range.startTime, endTime: range.endTime })} · 点击部门名称可直接下钻到该部门成员明细`}
              extra={<Badge tone="brand">{deptOptions.length} 个部门</Badge>}
            />
            <DataTable
              columns={columns}
              rows={departments}
              rowKey={(row) => row.departmentId}
              maxHeight={420}
              onRowClick={(row) => navigate(`/members?dept=${row.departmentId}`)}
            />
          </Card>
        </>
      )}
    </PageShell>
  )
}
