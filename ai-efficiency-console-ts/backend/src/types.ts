/**
 * 数据集与领域对象的类型定义。
 *
 * 边界说明
 * --------
 * 本文件只描述**数据的形状**，不含任何口径逻辑。指标聚合的返回类型
 * （`Index` / `Slice`）由 `metrics.ts` 自己拥有并导出，因为它们是口径的产物。
 *
 * 字段名刻意与 `gen_mock.py` 产出的 JSON 保持一致（含 `series` 里的短字段名），
 * 这样移植过程中不需要做任何映射，也便于与 Python 版逐字段对数。
 */

export interface Meta {
  generatedAt: string;
  referenceDay: string;
  windowDays: number;
  seed: number;
  enterpriseId: string;
  enterpriseName: string;
  note: string;
}

export interface Department {
  departmentId: string;
  departmentName: string;
  fullPath: string;
  parentId: string | null;
  level: number;
  status: string;
}

export interface Member {
  userId: string;
  userName: string;
  userNickname: string;
  email: string;
  primaryDepartmentId: string;
  primaryDepartmentName: string;
  departmentFullPath: string;
  departmentIds: string[];
  departmentNames: string[];
  departmentFullPaths: string[];
  joinedAt: string;
  lastActiveTime: string;
  activeDays: number;
  dialogCount: number;
  completionGenerateCount: number;
  completionAcceptCount: number;
  completionAcceptRateByCount: number | null;
  completionGenerateLines: number;
  completionAcceptLines: number;
  completionAcceptRateByLines: number | null;
  completionGenerateChars: number;
  completionAcceptChars: number;
  completionAcceptRateByChars: number | null;
  aiGenerateCodeLines: number;
  totalNewCodeLines: number;
  codeGenerateRateByLines: number | null;
  aiGenerateCodeChars: number;
  totalNewCodeChars: number;
  codeGenerateRateByChars: number | null;
  totalUsed: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * 周期限量。**可能为 `null`** —— 生成器对「不限量」成员写 `null`
   * （实测参考数据集 48 人中有 5 人如此，此时 `cycleLimitDisplay === '不限量'`）。
   * 声明成 `number` 会让下游不得不用 `as` 强行绕过，反而掩盖这个真实分支。
   */
  cycleLimit: number | null;
  cycleLimitDisplay: string;
  /** 生成器内部参数，仅在 mock 数据中出现 */
  [extra: string]: unknown;
}

/**
 * 日粒度行为记录。
 * 字段名是生成器定义的短名（`d`=日期、`u`=userId、`md`=model、`cl`=client …），
 * 口径层通过 `SUM_FIELDS` / `ROW_DIM_FIELD` 间接引用它们。
 */
export interface SeriesRow {
  d: string;
  u: string;
  [field: string]: number | string;
}

export interface QuotaCycle {
  cycleType: string;
  cycleMode: string;
  cycleStart: string;
  cycleEnd: string;
  nextCycleStart: string;
}

export interface DefaultQuota extends QuotaCycle {
  cycleLimit: number;
}

export interface ResourceSource {
  sourceType: string;
  name: string;
  total: number;
  used: number;
  [extra: string]: unknown;
}

export interface ResourceItem {
  resourceType: string;
  unit: string;
  total: number;
  used: number;
  remaining: number;
  remainingRatio: number;
  /**
   * 来源明细。**可选** —— 实测参考数据集里的 license 条目根本没有 `sources` 键
   * （只有用量类条目才有）。声明成必填会逼调用方写 `as unknown as` 断言，
   * 反而把"这里确实可能没有"这个事实掩盖掉。
   */
  sources?: ResourceSource[];
  [extra: string]: unknown;
}

export interface Resources {
  enterpriseId: string;
  items: ResourceItem[];
  [extra: string]: unknown;
}

export interface Dataset {
  meta: Meta;
  departments: Department[];
  members: Member[];
  quotaCycle: QuotaCycle;
  defaultQuota: DefaultQuota;
  resources: Resources;
  series: SeriesRow[];
}

/** 统一响应信封：`{ code, msg, requestId, data }`，与 Python 版逐字段一致。 */
export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  requestId: string;
  data?: T;
  [extra: string]: unknown;
}
