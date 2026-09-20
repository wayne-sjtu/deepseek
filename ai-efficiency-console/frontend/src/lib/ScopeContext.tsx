import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from './api'
import { rangeOfDays } from './format'
import type { DateRange, MockMeta, OverviewResponse, QuotaCycle } from './types'

/** 全局筛选：时间范围 + 部门范围，所有页面共享，保证口径一致。 */
export interface DepartmentOption {
  departmentId: string
  departmentName: string
  memberCount: number
}

export interface ScopeState {
  range: DateRange
  days: number
  departmentIds: string[]
  departments: DepartmentOption[]
  meta: MockMeta | null
  quotaCycle: QuotaCycle | null
  overview: OverviewResponse | null
  loading: boolean
  error: string | null
  lastUpdatedAt: number
}

interface ScopeContextValue extends ScopeState {
  setDays: (days: number) => void
  setRange: (range: DateRange) => void
  toggleDepartment: (id: string) => void
  clearDepartments: () => void
  refresh: () => void
}

const ScopeContext = createContext<ScopeContextValue | null>(null)

export function ScopeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => rangeOfDays(30), [])
  const [days, setDaysState] = useState(30)
  const [range, setRangeState] = useState<DateRange>(initial.current)
  const [departmentIds, setDepartmentIds] = useState<string[]>([])
  const [departments, setDepartments] = useState<DepartmentOption[]>([])
  const [meta, setMeta] = useState<MockMeta | null>(null)
  const [quotaCycle, setQuotaCycle] = useState<QuotaCycle | null>(null)
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(Date.now())
  const [nonce, setNonce] = useState(0)
  const requestId = useRef(0)

  const refresh = useCallback(() => {
    setNonce((value) => value + 1)
    setLastUpdatedAt(Date.now())
  }, [])

  const setDays = useCallback((next: number) => {
    setDaysState(next)
    setRangeState(rangeOfDays(next).current)
  }, [])

  const setRange = useCallback((next: DateRange) => {
    setRangeState(next)
    const start = new Date(`${next.startTime}T00:00:00`).getTime()
    const end = new Date(`${next.endTime}T00:00:00`).getTime()
    setDaysState(Math.max(1, Math.round((end - start) / 86400_000) + 1))
  }, [])

  // 元信息 + 部门名册：只在打开页面时请求一次
  useEffect(() => {
    let alive = true
    ;(async () => {
      const [metaResult, deptResult, firstOverview] = await Promise.allSettled([
        api.getMeta(),
        api.listDepartments(),
        api.getOverview({ timeRange: initial.current }),
      ])
      if (!alive) return
      if (metaResult.status === 'fulfilled') {
        setMeta(metaResult.value.meta)
        setQuotaCycle(metaResult.value.quotaCycle)
      }
      const counts = new Map<string, number>()
      if (firstOverview.status === 'fulfilled') {
        firstOverview.value.departments.forEach((d) => counts.set(d.departmentId, d.memberCount))
      }
      if (deptResult.status === 'fulfilled') {
        setDepartments(
          deptResult.value
            .filter((d) => d.parentId)
            .map((d) => ({
              departmentId: d.departmentId,
              departmentName: d.departmentName,
              memberCount: counts.get(d.departmentId) ?? 0,
            })),
        )
      }
    })()
    return () => {
      alive = false
    }
  }, [initial])

  // 主数据：时间范围 / 部门筛选 / 手动刷新 变化时重新拉取
  useEffect(() => {
    const current = ++requestId.current
    setLoading(true)
    api
      .getOverview({ timeRange: range, departmentIds })
      .then((data) => {
        if (current !== requestId.current) return
        setOverview(data)
        setError(null)
      })
      .catch((err: Error) => {
        if (current !== requestId.current) return
        setError(err.message)
      })
      .finally(() => {
        if (current === requestId.current) setLoading(false)
      })
  }, [range, departmentIds, nonce])

  const value: ScopeContextValue = {
    range,
    days,
    departmentIds,
    departments,
    meta,
    quotaCycle,
    overview,
    loading,
    error,
    lastUpdatedAt,
    setDays,
    setRange,
    toggleDepartment: (id: string) =>
      setDepartmentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    clearDepartments: () => setDepartmentIds([]),
    refresh,
  }

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext)
  if (!ctx) throw new Error('useScope 必须在 ScopeProvider 内使用')
  return ctx
}

/** 把筛选条件转换成接口请求参数 */
export function useQueryScope() {
  const { range, departmentIds } = useScope()
  return useMemo(() => ({ timeRange: range, departmentIds }), [range, departmentIds])
}
