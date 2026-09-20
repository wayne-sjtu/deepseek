import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardHeader, Badge, LoadingBlock, EmptyState, ProgressBar } from '../components/Card'
import { DataTable, type Column } from '../components/DataTable'
import { PageShell } from '../components/Layout'
import { MetricCardGrid, type KpiItem } from '../components/MetricCard'
import { useScope } from '../lib/ScopeContext'
import { api } from '../lib/api'
import { cx, downloadCsv, fmtCredit, fmtDateTime, fmtInt, fmtPercent, RISK_META, riskOf } from '../lib/format'
import type { AuditEntry, QuotaSummaryRow } from '../lib/types'

const RISK_TABS: Array<{ key: 'all' | 'high' | 'medium' | 'low' | 'unlimited'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'high', label: '超限风险 ≥90%' },
  { key: 'medium', label: '偏高 70~90%' },
  { key: 'low', label: '正常 <70%' },
  { key: 'unlimited', label: '不限量' },
]

export default function QuotaPage() {
  const { range, departmentIds, departments, meta, quotaCycle } = useScope()
  const [cycleMode, setCycleMode] = useState(true)

  /**
   * 额度口径的关键决策：
   * 额度风险必须按「企业额度周期」计算，而不是看板筛选窗口 —— 否则会出现
   * 「窗口消耗 60% 但实际周期已用满」的误判。因此本页默认对齐额度周期，
   * 同时保留按看板窗口查看的开关，便于做同期对比。
   */
  const effectiveRange = useMemo(() => {
    if (cycleMode && quotaCycle?.cycleStart) {
      const end = new Date(`${quotaCycle.cycleEnd.slice(0, 10)}T00:00:00`)
      end.setDate(end.getDate() - 1)
      return {
        startTime: quotaCycle.cycleStart.slice(0, 10),
        endTime: end.toISOString().slice(0, 10),
      }
    }
    return range
  }, [cycleMode, quotaCycle, range])
  const [rows, setRows] = useState<QuotaSummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [riskTab, setRiskTab] = useState<'all' | 'high' | 'medium' | 'low' | 'unlimited'>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [defaultLimit, setDefaultLimit] = useState<number>(0)
  const [targetLimit, setTargetLimit] = useState<number>(20000)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [deptTarget, setDeptTarget] = useState('')
  const [deptLimit, setDeptLimit] = useState<number>(20000)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [quota, metaInfo] = await Promise.all([
        api.listQuota({ timeRange: effectiveRange, departmentIds }, 1, 500, keyword),
        api.getMeta(),
      ])
      setRows(quota.items)
      setDefaultLimit(metaInfo.defaultQuota.cycleLimit)
      setAudit(metaInfo.audit)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [effectiveRange, departmentIds, keyword])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(timer)
  }, [toast])

  const filtered = useMemo(
    () => (riskTab === 'all' ? rows : rows.filter((row) => riskOf(row.__quotaUsageRate) === riskTab)),
    [rows, riskTab],
  )

  const stats = useMemo(() => {
    const limited = rows.filter((row) => row.cycleLimit !== null)
    const high = rows.filter((row) => riskOf(row.__quotaUsageRate) === 'high')
    const medium = rows.filter((row) => riskOf(row.__quotaUsageRate) === 'medium')
    const totalUsed = rows.reduce((acc, row) => acc + row.totalUsed, 0)
    const limitedQuota = limited.reduce((acc, row) => acc + (row.cycleLimit ?? 0), 0)
    const limitedUsed = limited.reduce((acc, row) => acc + row.totalUsed, 0)
    return {
      limited: limited.length,
      unlimited: rows.length - limited.length,
      high,
      medium,
      totalUsed,
      utilization: limitedQuota ? (limitedUsed / limitedQuota) * 100 : 0,
    }
  }, [rows])

  const kpis: KpiItem[] = useMemo(
    () => [
      { key: 'limited', label: '已配置限量成员', value: stats.limited, unit: '人', tone: 'brand', format: fmtInt, hint: '单独配置过周期限量的成员数' },
      { key: 'unlimited', label: '使用企业默认额度', value: stats.unlimited, unit: '人', tone: 'slate', format: fmtInt, hint: `当前默认额度 ${fmtInt(defaultLimit)} credits` },
      { key: 'high', label: '超限风险成员', value: stats.high.length, unit: '人', tone: 'rose', format: fmtInt, hint: '窗口消耗已达限量 90% 以上，需要立即处理' },
      { key: 'medium', label: '用量偏高成员', value: stats.medium.length, unit: '人', tone: 'amber', format: fmtInt, hint: '限量使用率 70%~90%，建议提前关注' },
      { key: 'used', label: '窗口总消耗', value: stats.totalUsed, unit: 'credits', tone: 'amber', format: (v) => fmtCredit(v), hint: `覆盖 ${rows.length} 名成员` },
      { key: 'util', label: '限量子集使用率', value: stats.utilization, unit: '%', tone: 'violet', format: (v) => v.toFixed(1), hint: '已配置限量成员的实际消耗 ÷ 配额总量' },
    ],
    [stats, defaultLimit, rows.length],
  )

  async function applyToMembers(userIds: string[], limit: number | null) {
    if (!userIds.length) return
    setBusy(true)
    try {
      const result = await api.updateMemberQuota(
        userIds,
        limit === null ? 'unlimited' : 'limited',
        limit === null ? undefined : limit,
      )
      setToast(`已更新 ${result.affectedCount} 名成员的额度${limit === null ? '（不限量）' : `（${fmtInt(limit)} credits）`}`)
      setSelected([])
      await load()
    } catch (err) {
      setToast(`调整失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function applyToDepartment() {
    if (!deptTarget) return
    setBusy(true)
    try {
      const result = await api.updateDepartmentQuota(deptTarget, 'limited', deptLimit)
      setToast(`已将部门下 ${result.affectedCount} 名成员额度调整为 ${fmtInt(deptLimit)} credits`)
      await load()
    } catch (err) {
      setToast(`调整失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<Column<QuotaSummaryRow>> = [
    {
      key: 'select',
      title: (
        <input
          type="checkbox"
          aria-label="全选"
          checked={filtered.length > 0 && selected.length === filtered.length}
          onChange={(event) => setSelected(event.target.checked ? filtered.map((row) => row.userId) : [])}
          className="h-3.5 w-3.5 accent-brand-500"
        />
      ),
      width: '42px',
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择 ${row.userName}`}
          checked={selected.includes(row.userId)}
          onChange={(event) =>
            setSelected((prev) => (event.target.checked ? [...prev, row.userId] : prev.filter((id) => id !== row.userId)))
          }
          onClick={(event) => event.stopPropagation()}
          className="h-3.5 w-3.5 accent-brand-500"
        />
      ),
    },
    {
      key: 'name',
      title: '成员',
      sortKey: 'userName',
      render: (row) => (
        <div className="leading-tight">
          <p className="font-medium text-slate-100">{row.userName}</p>
          <p className="text-[10px] text-slate-500">{row.departmentName}</p>
        </div>
      ),
    },
    {
      key: 'used',
      title: '窗口消耗',
      sortKey: 'totalUsed',
      align: 'right',
      render: (row) => <span className="text-amber-300">{fmtCredit(row.totalUsed)}</span>,
    },
    {
      key: 'limit',
      title: '周期限量',
      sortKey: 'cycleLimit',
      align: 'right',
      render: (row) => (
        <span className={cx(row.cycleLimit === null && 'text-slate-500')}>
          {row.cycleLimit === null ? '不限量' : fmtInt(row.cycleLimit)}
        </span>
      ),
    },
    {
      key: 'rate',
      title: '使用率',
      sortKey: '__quotaUsageRate',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <span className={cx('font-mono', row.__quotaUsageRate === null ? 'text-slate-500' : row.__quotaUsageRate >= 90 ? 'text-rose-400' : row.__quotaUsageRate >= 70 ? 'text-amber-400' : 'text-mint-400')}>
            {row.__quotaUsageRate === null ? '—' : fmtPercent(row.__quotaUsageRate)}
          </span>
          <div className="w-16">
            <ProgressBar
              value={row.__quotaUsageRate ?? 0}
              tone={row.__quotaUsageRate === null ? 'brand' : row.__quotaUsageRate >= 90 ? 'rose' : row.__quotaUsageRate >= 70 ? 'amber' : 'mint'}
              height={4}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'risk',
      title: '风险',
      sortKey: 'riskLevel',
      render: (row) => {
        const risk = RISK_META[riskOf(row.__quotaUsageRate)]
        return <span className={cx('rounded-md px-2 py-0.5 text-[11px]', risk.className)}>{risk.label}</span>
      },
    },
    {
      key: 'action',
      title: '快捷调整',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              void applyToMembers([row.userId], Math.max(1000, Math.round(row.totalUsed * 1.25)))
            }}
            className="rounded-md bg-white/[0.07] px-2 py-1 text-[11px] text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.12]"
            title="按当前消耗的 125% 重新设置限量"
          >
            消耗×1.25
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              void applyToMembers([row.userId], null)
            }}
            className="rounded-md bg-white/[0.07] px-2 py-1 text-[11px] text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.12]"
          >
            不限量
          </button>
        </div>
      ),
    },
  ]

  return (
    <PageShell
      title="额度管理"
      description={`按额度周期口径识别风险（当前统计 ${effectiveRange.startTime} ~ ${effectiveRange.endTime}），支持按成员 / 按部门批量调整周期限量，对应企业接口 usage/members/quota/update 与 usage/departments/{id}/quota/update。`}
      actions={
        <>
          <div className="flex items-center rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.06]">
            <button
              type="button"
              onClick={() => setCycleMode(true)}
              className={cx(
                'rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors',
                cycleMode ? 'bg-brand-500/90 text-white' : 'text-slate-400 hover:text-slate-100',
              )}
            >
              对齐额度周期
            </button>
            <button
              type="button"
              onClick={() => setCycleMode(false)}
              className={cx(
                'rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors',
                !cycleMode ? 'bg-brand-500/90 text-white' : 'text-slate-400 hover:text-slate-100',
              )}
            >
              跟随看板窗口
            </button>
          </div>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                '额度风险清单.csv',
                ['成员', '部门', '窗口消耗', '周期限量', '使用率%', '风险等级'],
                filtered.map((row) => [
                  row.userName, row.departmentName, row.totalUsed,
                  row.cycleLimit ?? '不限量', row.__quotaUsageRate, RISK_META[riskOf(row.__quotaUsageRate)].label,
                ]),
              )
            }
            className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
          >
            导出风险清单
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/[0.08] hover:bg-white/[0.1]"
          >
            重新加载
          </button>
        </>
      }
    >
      {toast && (
        <div className="rounded-xl border border-brand-500/30 bg-brand-500/[0.1] px-4 py-2.5 text-xs text-brand-100">
          {toast}
        </div>
      )}

      <MetricCardGrid items={kpis} columns={6} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <Card>
          <CardHeader title="批量调整成员额度" subtitle="勾选左侧成员后统一设置（推荐用 userId 提交）" />
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Badge tone={selected.length ? 'brand' : 'neutral'}>已选 {selected.length} 人</Badge>
              {selected.length > 0 && (
                <button type="button" onClick={() => setSelected([])} className="text-[11px] text-brand-300 hover:text-brand-400">
                  清空
                </button>
              )}
            </div>
            <label className="block text-[11px] text-slate-400">
              新周期限量（Credits）
              <input
                type="number"
                min={1}
                value={targetLimit}
                onChange={(event) => setTargetLimit(Number(event.target.value))}
                className="mt-1 w-full rounded-lg bg-white/[0.05] px-3 py-2 font-mono text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none focus:ring-brand-500/50"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || selected.length === 0}
                onClick={() => void applyToMembers(selected, targetLimit)}
                className="flex-1 rounded-lg bg-brand-500/90 px-3 py-2 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                应用到选中成员
              </button>
              <button
                type="button"
                disabled={busy || selected.length === 0}
                onClick={() => void applyToMembers(selected, null)}
                className="rounded-lg bg-white/[0.07] px-3 py-2 text-xs text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
              >
                设为不限量
              </button>
            </div>
            <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[10px] leading-relaxed text-slate-500">
              当前企业默认额度：<span className="font-mono text-slate-300">{fmtInt(defaultLimit)}</span> credits。
              调整企业默认额度只影响「使用默认额度」的成员；已单独配置过限量的成员需在此逐项调整。
            </p>
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader
            title="风险分布"
            subtitle="按限量使用率分档；超限成员建议先确认是否为真实提效场景，再决定提额或治理"
          />
          <div className="space-y-3">
            <RiskBar label="超限风险 ≥90%" count={stats.high.length} total={stats.limited} tone="rose" onClick={() => setRiskTab('high')} />
            <RiskBar label="偏高 70~90%" count={stats.medium.length} total={stats.limited} tone="amber" onClick={() => setRiskTab('medium')} />
            <RiskBar
              label="正常 <70%"
              count={stats.limited - stats.high.length - stats.medium.length}
              total={stats.limited}
              tone="mint"
              onClick={() => setRiskTab('low')}
            />
            <RiskBar label="不限量" count={stats.unlimited} total={rows.length} tone="brand" onClick={() => setRiskTab('unlimited')} />
          </div>
        </Card>

        <Card>
          <CardHeader title="按部门批量调整" subtitle="对应 usage/departments/{departmentId}/quota/update" />
          <div className="space-y-3">
            <label className="block text-[11px] text-slate-400">
              目标部门
              <select
                value={deptTarget}
                onChange={(event) => setDeptTarget(event.target.value)}
                className="mt-1 w-full rounded-lg bg-white/[0.05] px-3 py-2 text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none focus:ring-brand-500/50 [&>option]:bg-ink-800"
              >
                <option value="">请选择部门</option>
                {departments.map((dept) => (
                  <option key={dept.departmentId} value={dept.departmentId}>
                    {dept.departmentName}（{dept.memberCount} 人）
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-slate-400">
              统一限量（Credits）
              <input
                type="number"
                min={1}
                value={deptLimit}
                onChange={(event) => setDeptLimit(Number(event.target.value))}
                className="mt-1 w-full rounded-lg bg-white/[0.05] px-3 py-2 font-mono text-xs text-slate-100 ring-1 ring-white/[0.08] outline-none focus:ring-brand-500/50"
              />
            </label>
            <button
              type="button"
              disabled={busy || !deptTarget}
              onClick={() => void applyToDepartment()}
              className="w-full rounded-lg bg-brand-500/90 px-3 py-2 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              应用到部门全部成员
            </button>
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-[10px] leading-relaxed text-amber-200/80">
              部门级调整会覆盖该部门下所有成员（含已单独配置的成员），属于高影响操作，建议配合上方风险清单确认后再执行。
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="成员额度与消耗明细"
          subtitle={`统计窗口 ${effectiveRange.startTime} ~ ${effectiveRange.endTime}${meta ? ` · 数据生成于 ${meta.generatedAt.slice(0, 10)}` : ''}${
            cycleMode && quotaCycle ? ` · 额度周期 ${quotaCycle.cycleMode === 'natural_month' ? '自然月' : '订阅生效日切片'}` : ''
          }`}
          extra={
            <div className="flex items-center gap-2">
              <Badge tone={cycleMode ? 'brand' : 'amber'}>
                {cycleMode ? '额度周期口径' : '看板窗口口径'}
              </Badge>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索成员 / 部门"
                className="w-40 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11px] text-slate-100 ring-1 ring-white/[0.08] outline-none placeholder:text-slate-500 focus:ring-brand-500/50"
              />
            </div>
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {RISK_TABS.map((tab) => {
            const count =
              tab.key === 'all' ? rows.length : rows.filter((row) => riskOf(row.__quotaUsageRate) === tab.key).length
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setRiskTab(tab.key)}
                className={cx(
                  'rounded-lg px-2.5 py-1.5 text-[11px] ring-1 transition-colors',
                  riskTab === tab.key
                    ? 'bg-brand-500/90 text-white ring-brand-400/50'
                    : 'bg-white/[0.04] text-slate-300 ring-white/[0.07] hover:text-white',
                )}
              >
                {tab.label}
                <span className="ml-1 opacity-70">{count}</span>
              </button>
            )
          })}
        </div>

        {loading ? (
          <LoadingBlock />
        ) : error ? (
          <EmptyState title="加载失败" hint={error} />
        ) : (
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(row) => row.userId}
            localSort
            defaultSort={{ key: '__quotaUsageRate', order: 'desc' }}
            maxHeight={560}
          />
        )}
      </Card>

      <Card>
        <CardHeader title="调整审计" subtitle="Mock 服务记录的本轮会话内的额度变更操作（真实环境应由企业侧审计日志提供）" />
        {audit.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">本次会话暂无额度调整记录</p>
        ) : (
          <ul className="space-y-2">
            {[...audit].reverse().map((entry, index) => (
              <li key={index} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-[11px]">
                <span className="text-slate-300">
                  {entry.action === 'department-quota' ? `部门调整（${entry.departmentId}）` : entry.action === 'members-quota' ? '成员批量调整' : '企业默认额度调整'}
                  <span className="ml-2 text-slate-500">
                    {entry.limitType === 'unlimited' ? '不限量' : `限量 ${fmtInt(entry.newLimit ?? 0)}`}
                  </span>
                </span>
                <span className="text-slate-400">
                  影响 {entry.affectedCount} 人 · {fmtDateTime(entry.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageShell>
  )
}

function RiskBar({
  label,
  count,
  total,
  tone,
  onClick,
}: {
  label: string
  count: number
  total: number
  tone: 'mint' | 'amber' | 'rose' | 'brand'
  onClick: () => void
}) {
  const percent = total ? (count / total) * 100 : 0
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-400">
          {count} 人 <span className="text-slate-500">{fmtPercent(percent)}</span>
        </span>
      </div>
      <div className="mt-1.5">
        <ProgressBar value={percent} tone={tone} height={6} />
      </div>
    </button>
  )
}
