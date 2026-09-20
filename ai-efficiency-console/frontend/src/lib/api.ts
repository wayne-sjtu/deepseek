import type {
  AuditEntry,
  DashboardResponse,
  MemberDataResponse,
  MemberDetailResponse,
  MockMeta,
  OverviewResponse,
  QuotaSummaryRow,
} from './types'

/**
 * 数据访问层。
 *
 * 设计原则：**页面只依赖本模块暴露的强类型函数**，不关心数据来自 mock 还是真实接口。
 * 切换方式：`frontend/.env.local` 里设置
 *   VITE_DATA_MODE=mock   # 走本地 Python mock 服务（默认）
 *   VITE_DATA_MODE=live   # 走企业 OpenAPI（由同一后端做代理与 rollup）
 */
export type DataMode = 'mock' | 'live'

const MODE: DataMode = (import.meta.env.VITE_DATA_MODE as DataMode) || 'mock'
const BASE = (import.meta.env.VITE_API_BASE as string) || ''

export const dataMode = MODE

function url(path: string): string {
  return `${BASE}${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url(path), {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch (error) {
    throw new Error(
      `无法连接数据服务（${BASE || '同源'}${path}）。请确认已启动后端：\n` +
        `  python3 backend/app/server.py --port 8000\n` +
        `原始错误：${(error as Error).message}`,
    )
  }
  const text = await response.text()
  let payload: any
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(payload?.msg || `请求失败 HTTP ${response.status}`)
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg || `接口返回错误码 ${payload.code}`)
  }
  return payload.data as T
}

function rangeQuery(scope: {
  timeRange: { startTime: string; endTime: string }
  departmentIds?: string[]
  userIds?: string[]
}): string {
  const params = new URLSearchParams()
  params.set('startTime', scope.timeRange.startTime)
  params.set('endTime', scope.timeRange.endTime)
  if (scope.departmentIds?.length) params.set('departmentIds', scope.departmentIds.join(','))
  if (scope.userIds?.length) params.set('userIds', scope.userIds.join(','))
  return params.toString()
}

// ---------------------------------------------------------------------------
// 本方案扩展接口（后端 rollup，一次拿齐首屏）
// ---------------------------------------------------------------------------
export const api = {
  mode: MODE,

  getOverview(scope: Parameters<typeof rangeQuery>[0]): Promise<OverviewResponse> {
    return request<OverviewResponse>(`/api/v1/efficiency/overview?${rangeQuery(scope)}`)
  },

  getMembers(
    scope: Parameters<typeof rangeQuery>[0] & {
      page?: number
      pageSize?: number
      sortBy?: string
      sortOrder?: 'asc' | 'desc'
      keyword?: string
    },
  ): Promise<MemberDataResponse> {
    const params = new URLSearchParams(rangeQuery(scope))
    params.set('page', String(scope.page ?? 1))
    params.set('pageSize', String(scope.pageSize ?? 20))
    if (scope.sortBy) params.set('sortBy', scope.sortBy)
    if (scope.sortOrder) params.set('sortOrder', scope.sortOrder)
    if (scope.keyword) params.set('keyword', scope.keyword)
    return request<MemberDataResponse>(`/api/v1/efficiency/members?${params.toString()}`)
  },

  getMemberDetail(memberId: string, scope: Parameters<typeof rangeQuery>[0]): Promise<MemberDetailResponse> {
    return request<MemberDetailResponse>(
      `/api/v1/efficiency/member/${encodeURIComponent(memberId)}?${rangeQuery(scope)}`,
    )
  },

  getMeta(): Promise<{
    meta: MockMeta
    quotaCycle: OverviewResponse['org']['quotaCycle']
    defaultQuota: { cycleLimit: number; cycleMode: string; cycleStart: string; cycleEnd: string }
    audit: AuditEntry[]
  }> {
    return request(`/api/v1/efficiency/meta`)
  },

  listQuota(
    scope: Parameters<typeof rangeQuery>[0],
    page = 1,
    pageSize = 200,
    keyword = '',
  ): Promise<{ items: QuotaSummaryRow[]; totalCount: number }> {
    const params = new URLSearchParams(rangeQuery(scope))
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    if (keyword) params.set('keyword', keyword)
    return request(`/api/v1/efficiency/quota?${params.toString()}`)
  },

  listDepartments(): Promise<Array<{ departmentId: string; departmentName: string; parentId: string | null }>> {
    return request(`/api/enterprises/${enterpriseId()}/openapi/departments`).then(
      (data: any) => data.items ?? [],
    )
  },

  // -------------------------------------------------------------------------
  // 对齐 document.yaml 的企业接口（页面暂未全部使用，供二期扩展与联调核对）
  // -------------------------------------------------------------------------
  memberData(payload: unknown): Promise<MemberDataResponse> {
    return request<MemberDataResponse>(`/api/enterprises/${enterpriseId()}/dashboard/member/data`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  analytics(
    kind: 'activity' | 'dialog' | 'completion' | 'generation',
    payload: unknown,
  ): Promise<DashboardResponse> {
    return request<DashboardResponse>(
      `/api/enterprises/${enterpriseId()}/dashboard/analytics/${kind}`,
      { method: 'POST', body: JSON.stringify(payload) },
    )
  },

  updateMemberQuota(userIds: string[], limitType: 'limited' | 'unlimited', newLimit?: number) {
    return request<{ affectedCount: number }>(
      `/api/enterprises/${enterpriseId()}/openapi/usage/members/quota/update`,
      { method: 'POST', body: JSON.stringify({ userIds, limitType, newLimit }) },
    )
  },

  updateDepartmentQuota(departmentId: string, limitType: 'limited' | 'unlimited', newLimit?: number) {
    return request<{ affectedCount: number }>(
      `/api/enterprises/${enterpriseId()}/openapi/usage/departments/${departmentId}/quota/update`,
      { method: 'POST', body: JSON.stringify({ limitType, newLimit }) },
    )
  },
}

function enterpriseId(): string {
  return (import.meta.env.VITE_ENTERPRISE_ID as string) || '1234567890'
}
