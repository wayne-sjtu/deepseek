/**
 * 指标聚合层 —— `backend/app/metrics.py`（327 行）的逐行 TypeScript 移植。
 *
 * 职责：把「成员 × 日」粒度的原始数据聚合成接口文档要求的各种口径。
 * 关键约束：**部门 / 公司级指标一律由成员日粒度求和得到**，不单独生成，
 * 因此「部门汇总之和 == 公司总量」永远成立，前端不会出现对不齐的数字。
 *
 * 口径映射（document.yaml）
 * ------------------------
 * 成员级字段直接对应 /dashboard/member/data 的返回字段（L1828-L1923）。
 * 派生比率一律「先求和再相除」，避免平均平均数的辛普森悖论。
 *
 * 移植忠实性说明（为什么这些细节不能"顺手改好"）
 * --------------------------------------------
 *   1. **round 语义**：源文件所有 `round(x, 1)` / `round(x, 2)` 都走
 *      `pyround.ts` 的 `round1` / `round2`（Python round-half-even + 精确十进制基准）。
 *      绝不能用 `Math.round(x * 100) / 100` —— 平局方向与舍入基准都不同。
 *   2. **`_ratio` 分母为 0 时返回 `null`**（不是 0，也不是 NaN）。前端会把这个
 *      `null` 渲染成「—/不可用」，0 会被渲染成一个真实的零，两者语义完全不同。
 *   3. **累加顺序**：`org` / 成员桶 / 部门桶的逐行累加顺序与 Python 完全一致
 *      （按 `days` 升序、日内按数据集原始顺序，字段按 `SUM_FIELDS` 声明顺序）。
 *      浮点加法不满足结合律，顺序变了末位就会变。
 *   4. **时区**：本文件不做任何时间转换 —— `d` 是裸日期串（YYYY-MM-DD），
 *      窗口比较是**字符串比较**，与 Python 逐字符一致。`lastActiveTime` 里的
 *      `+08:00` 是源文件里写死的字面量（原 `TZ = UTC+8`），照搬。
 *   5. **`_iter_rows` 用的是字符串比较**（`day < start`），不是日期解析：
 *      所以 `aggregate` 的 `start`/`end` 必须与 `d` 同为补零的 ISO 日期串。
 *
 * 零运行时依赖：只用到 BigInt / DataView（`pyround.ts` 内部），无 npm 包。
 */

import { round1, round2 } from './pyround.ts';
import type { Dataset, Department, Member, SeriesRow } from './types.ts';

// ---------------------------------------------------------------------------
// 求和型字段（绝对量），其余为比率型
// ---------------------------------------------------------------------------
export const SUM_FIELDS = [
  'cg', 'ca', 'cgl', 'cal', 'cgc', 'cac',
  'dc', 'dk', 'dcr', 'dcy', 'dcm', 'dct', 'da', 'dkb', 'dac',
  'ail', 'tnl', 'aic', 'tnc',
  'cr', 'crc', 'it', 'ot', 'cri',
  'sc', 'rq', 'err', 'tc', 'te',
] as const;

export type SumField = (typeof SUM_FIELDS)[number];

/** 聚合过程中的纯求和桶：`SUM_FIELDS` 里的每个字段都是数字。 */
export type Totals = Record<string, number>;

/**
 * `_finalize()` 的产物 / `Slice` 里每个组织的指标表。
 * 求和字段仍是数字，派生比率是 `number | null`，成员级还挂字符串与数组。
 */
export type MetricsRecord = Record<string, number | string | string[] | null>;

// ---------------------------------------------------------------------------
// 索引与结果类型（由本文件拥有：它们是口径的产物，不是数据形状）
// ---------------------------------------------------------------------------

/** `buildIndexes()` 的产物：预计算索引，避免每次请求都线性扫描。 */
export interface Index {
  /** userId -> 成员元数据（对应 Python `members`） */
  members: Map<string, Member>;
  /** userId -> primaryDepartmentId（对应 Python `dept_of`，缺值为 null） */
  deptOf: Map<string, string | null>;
  /** 日期 -> 该日记录列表，保持数据集原始顺序（对应 Python `by_day`） */
  byDay: Map<string, SeriesRow[]>;
  /** 升序排列的日期（对应 Python `days`） */
  days: string[];
  /** departmentId -> 部门元数据（对应 Python `departments`） */
  departments: Map<string, Department>;
}

/** 一个时间窗口内的聚合结果（对应 Python `dataclass Slice`）。 */
export interface Slice {
  start: string;
  end: string;
  days: number;
  org: MetricsRecord;
  departments: Record<string, MetricsRecord>;
  members: Record<string, MetricsRecord>;
}

/** 对应 `Slice.to_dict()`。JS 对象本身可直接 `JSON.stringify`，保留此函数以便逐行对应。 */
export function sliceToDict(slice: Slice): Slice {
  return {
    start: slice.start,
    end: slice.end,
    days: slice.days,
    org: slice.org,
    departments: slice.departments,
    members: slice.members,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** dict 的 `.get(key, default)` 语义：**键存在但值为 null/undefined 时不回落**。 */
function dictGet<T>(dict: object | undefined, key: string, fallback: T): T {
  if (dict === undefined) return fallback;
  return Object.prototype.hasOwnProperty.call(dict, key)
    ? ((dict as Record<string, unknown>)[key] as T)
    : fallback;
}

/** Map 的 `.get(key, default)` 语义（Python dict `.get` 的忠实对应）。 */
function mapGet<K, V>(map: Map<K, V>, key: K, fallback: V): V {
  return map.has(key) ? (map.get(key) as V) : fallback;
}

/** 对应 Python `_empty_totals()`：所有求和字段归零，`cr`/`crc` 是浮点桶。 */
function emptyTotals(): Totals {
  const totals: Totals = {};
  for (const key of SUM_FIELDS) totals[key] = 0;
  totals['cr'] = 0.0;
  totals['crc'] = 0.0;
  return totals;
}

/** 对应 Python `_ratio`：分母为 0 时返回 `null`（绝不能变成 NaN 或 0）。 */
function ratio(num: number, den: number): number | null {
  // Python 的 `if not den`：0 / 0.0 / -0.0 / None 为假；NaN 为真（故先排除 0，再放过 NaN）。
  if (!den && !Number.isNaN(den)) return null;
  return round2((num / den) * 100);
}

/** 对应 Python `_finalize(totals, member_count=1)`（`member_count` 在 Python 里并未被使用）。 */
function finalize(totals: Totals): MetricsRecord {
  const out: MetricsRecord = { ...totals };
  out['completionAcceptRateByCount'] = ratio(totals['ca'], totals['cg']);
  out['completionAcceptRateByLines'] = ratio(totals['cal'], totals['cgl']);
  out['completionAcceptRateByChars'] = ratio(totals['cac'], totals['cgc']);
  out['codeGenerateRateByLines'] = ratio(totals['ail'], totals['tnl']);
  out['codeGenerateRateByChars'] = ratio(totals['aic'], totals['tnc']);
  out['credit'] = round2(totals['cr']);
  out['aiCodeLines'] = totals['ail'];
  out['totalNewCodeLines'] = totals['tnl'];
  out['dialogCount'] = totals['dc'];
  // 与 document.yaml /dashboard/member/data 字段命名对齐的别名
  out['completionGenerateCount'] = totals['cg'];
  out['completionAcceptCount'] = totals['ca'];
  out['completionGenerateLines'] = totals['cgl'];
  out['completionAcceptLines'] = totals['cal'];
  out['completionGenerateChars'] = totals['cgc'];
  out['completionAcceptChars'] = totals['cac'];
  out['aiGenerateCodeLines'] = totals['ail'];
  out['totalNewCodeLines'] = totals['tnl'];
  out['aiGenerateCodeChars'] = totals['aic'];
  out['totalNewCodeChars'] = totals['tnc'];
  out['sessionCount'] = totals['sc'];
  out['requestCount'] = totals['rq'];
  out['toolCallCount'] = totals['tc'];
  out['inputTokens'] = totals['it'];
  out['outputTokens'] = totals['ot'];
  out['tokenUsage'] = totals['it'] + totals['ot'];
  out['cacheReadInputTokens'] = totals['cri'];
  // 可靠性 / 时延派生指标
  out['requestErrorRate'] = ratio(totals['err'], totals['rq']);
  out['toolErrorRate'] = ratio(totals['te'], totals['tc']);
  return out;
}

// ---------------------------------------------------------------------------
// 口径实现
// ---------------------------------------------------------------------------

/** 预计算索引，避免每次请求都线性扫描。对应 Python `build_indexes`。 */
export function buildIndexes(dataset: Dataset): Index {
  const members = new Map<string, Member>();
  const deptOf = new Map<string, string | null>();
  for (const m of dataset.members) {
    members.set(m.userId, m);
    deptOf.set(m.userId, m.primaryDepartmentId);
  }
  // 按日 -> 记录列表，便于时间窗口切片
  const byDay = new Map<string, SeriesRow[]>();
  for (const row of dataset.series) {
    const bucket = byDay.get(row.d);
    if (bucket === undefined) byDay.set(row.d, [row]);
    else bucket.push(row);
  }
  return {
    members,
    deptOf,
    byDay,
    days: [...byDay.keys()].sort(),
    departments: new Map(dataset.departments.map((d) => [d.departmentId, d])),
  };
}

/** 对应 Python `_iter_rows`：窗口是**字符串闭区间**，日内保持数据集原始顺序。 */
function* iterRows(
  index: Index,
  start: string,
  end: string,
  userIds: Set<string> | null,
): Generator<SeriesRow> {
  for (const day of index.days) {
    if (day < start || day > end) continue;
    for (const row of index.byDay.get(day) ?? []) {
      if (userIds !== null && !userIds.has(row.u)) continue;
      yield row;
    }
  }
}

/** `_empty_totals()` 的字段累加：值必须是数字，否则 Python 会抛错而不是静默变 NaN。 */
function addTo(target: Totals, row: SeriesRow, key: string): void {
  const value = row[key] as number;
  if (typeof value !== 'number') {
    throw new TypeError(`series 行缺少数值字段 ${key}：${JSON.stringify(row)}`);
  }
  target[key] += value;
}

/**
 * 按 [start, end] 闭区间聚合，可选按成员 / 部门下钻。对应 Python `aggregate`。
 *
 * `userIds` / `departmentIds` 为 null 表示不筛；`departmentIds` 为空集视作不筛
 * （Python 的 `if department_ids:`），而 `userIds` 为空集会把所有行筛掉。
 */
export function aggregate(
  dataset: Dataset,
  index: Index,
  start: string,
  end: string,
  userIds: Set<string> | null = null,
  departmentIds: Set<string> | null = null,
): Slice {
  userIds = userIds ?? null;
  departmentIds = departmentIds ?? null;

  if (departmentIds && departmentIds.size > 0) {
    const scoped = new Set<string>();
    for (const [uid, did] of index.deptOf) {
      if (did !== null && departmentIds.has(did)) scoped.add(uid);
    }
    userIds = userIds === null ? scoped : new Set([...userIds].filter((u) => scoped.has(u)));
  }

  const org = emptyTotals();
  const perMember = new Map<string, Totals>();
  const perDept = new Map<string, Totals>();
  const activeDays = new Map<string, Set<string>>();
  const lastActive = new Map<string, string>();
  const distinctDays = new Set<string>();

  for (const row of iterRows(index, start, end, userIds)) {
    const uid = row.u;
    let bucket = perMember.get(uid);
    if (bucket === undefined) {
      bucket = emptyTotals();
      perMember.set(uid, bucket);
    }
    for (const key of SUM_FIELDS) {
      addTo(org, row, key);
      addTo(bucket, row, key);
    }
    let seen = activeDays.get(uid);
    if (seen === undefined) {
      seen = new Set<string>();
      activeDays.set(uid, seen);
    }
    seen.add(row.d);
    if (!lastActive.has(uid) || row.d > (lastActive.get(uid) as string)) {
      lastActive.set(uid, row.d);
    }
    distinctDays.add(row.d);
    const deptId = index.deptOf.get(uid);
    if (deptId) {
      let deptBucket = perDept.get(deptId);
      if (deptBucket === undefined) {
        deptBucket = emptyTotals();
        perDept.set(deptId, deptBucket);
      }
      for (const key of SUM_FIELDS) {
        addTo(deptBucket, row, key);
      }
    }
  }

  const days = distinctDays.size;
  const orgOut = finalize(org);
  orgOut['activeUserNum'] = perMember.size;
  orgOut['dau'] = days ? round1(perMember.size / days) : 0;
  orgOut['avgCreditsPerActiveUser'] = perMember.size ? round2(org['cr'] / perMember.size) : 0;
  orgOut['avgAiLinesPerActiveUser'] = perMember.size ? round1(org['ail'] / perMember.size) : 0;

  const departmentsOut: Record<string, MetricsRecord> = {};
  for (const [deptId, totals] of perDept) {
    const deptMembers: string[] = [];
    for (const uid of perMember.keys()) {
      if (index.deptOf.get(uid) === deptId) deptMembers.push(uid);
    }
    if (deptMembers.length === 0) continue;
    const out = finalize(totals);
    out['departmentId'] = deptId;
    out['activeUserNum'] = deptMembers.length;
    const memberCount = dataset.members.reduce(
      (acc, m) => acc + (m.primaryDepartmentId === deptId ? 1 : 0),
      0,
    );
    out['memberCount'] = memberCount;
    out['activeRate'] = ratio(deptMembers.length, memberCount) ?? 0.0;
    out['avgCreditsPerActiveUser'] = round2(totals['cr'] / deptMembers.length);
    out['avgAiLinesPerActiveUser'] = round1(totals['ail'] / deptMembers.length);
    out['creditsPerKline'] = totals['tnl'] ? round2(totals['cr'] / (totals['tnl'] / 1000.0)) : null;
    departmentsOut[deptId] = out;
  }

  const membersOut: Record<string, MetricsRecord> = {};
  for (const [uid, totals] of perMember) {
    const meta = index.members.get(uid);
    const out = finalize(totals);
    out['userId'] = uid;
    out['userName'] = dictGet<string | null>(meta, 'userName', null);
    out['userNickname'] = dictGet<string | null>(meta, 'userNickname', null);
    out['primaryDepartmentId'] = dictGet<string | null>(meta, 'primaryDepartmentId', null);
    out['primaryDepartmentName'] = dictGet<string | null>(meta, 'primaryDepartmentName', null);
    out['departmentFullPaths'] = dictGet<string[]>(meta, 'departmentFullPaths', []);
    const activeDaysCount = (activeDays.get(uid) ?? new Set<string>()).size;
    out['activeDays'] = activeDaysCount;
    out['lastActiveTime'] = lastActive.has(uid) ? `${lastActive.get(uid)}T17:42:00+08:00` : null;
    out['cycleLimit'] = dictGet<number | null>(meta, 'cycleLimit', null);
    out['cycleLimitDisplay'] = dictGet<string | null>(meta, 'cycleLimitDisplay', null);
    // 配额使用率：仅对限量成员有意义，不限量返回 null
    const limit = dictGet<number | null>(meta, 'cycleLimit', null);
    out['quotaUsageRate'] = limit ? ratio(totals['cr'], limit) : null;
    out['creditsPerKline'] = totals['tnl'] ? round2(totals['cr'] / (totals['tnl'] / 1000.0)) : null;
    // 人均日产出，用于识别「高消耗低产出」
    out['aiLinesPerActiveDay'] = activeDaysCount ? round1(totals['ail'] / activeDaysCount) : 0;
    membersOut[uid] = out;
  }

  return {
    start,
    end,
    days,
    org: orgOut,
    departments: departmentsOut,
    members: membersOut,
  };
}

// ---------------------------------------------------------------------------
// 趋势与分组
// ---------------------------------------------------------------------------

export const GROUP_DIMENSIONS: Record<string, string> = {
  department: '主部门',
  user: '成员',
  model: '模型',
  client: '客户端',
  plugin: '插件版本',
  language: '编程语言',
  taskScene: '任务场景',
};

export const ROW_DIM_FIELD: Record<string, string> = {
  model: 'md',
  client: 'cl',
  plugin: 'pv',
  language: 'lg',
};

// 可观测白名单指标 -> 原始字段
export const METRIC_WHITELIST: Record<string, [string, string]> = {
  // 指标名: (原始字段, 单位)
  genai_request_count: ['rq', ''],
  model_request_count: ['rq', ''],
  model_error_count: ['err', ''],
  tool_call_count: ['tc', ''],
  tool_error_count: ['te', ''],
  tool_error_rate: ['__tool_error_rate__', '%'],
  session_count: ['sc', ''],
  user_count: ['__user_count__', ''],
  dau: ['__dau__', ''],
  credit: ['cr', ''],
  credit_cost: ['crc', ''],
  input_token: ['it', ''],
  output_token: ['ot', ''],
  token_usage: ['__token_usage__', ''],
  cache_read_input_token: ['cri', ''],
  ttft_avg: ['ttft', 'ms'],
  ttft_p50: ['p50', 'ms'],
  ttft_p90: ['p90', 'ms'],
  ttft_p95: ['p95', 'ms'],
  ttft_p99: ['p99', 'ms'],
  genai_operation_duration_avg: ['dur', 'ms'],
  model_invocation_duration_p50: ['dp50', 'ms'],
  model_invocation_duration_p95: ['dp95', 'ms'],
  completion_accept_rate_by_lines: ['__accept_line_rate__', '%'],
  code_generate_rate_by_lines: ['__gen_line_rate__', '%'],
  ai_generate_code_lines: ['ail', ''],
  total_new_code_lines: ['tnl', ''],
  dialog_count: ['dc', ''],
};

/** 这类指标需要按权重平均而非求和（源实现以记录条数近似加权，此处照搬）。 */
const LATENCY_METRICS = new Set([
  'ttft_avg',
  'ttft_p50',
  'ttft_p90',
  'ttft_p95',
  'ttft_p99',
  'genai_operation_duration_avg',
  'model_invocation_duration_p50',
  'model_invocation_duration_p95',
]);

/**
 * 取白名单指标的值。对应 Python `_metric_value`。
 * 未知指标名抛错（Python 抛 `KeyError`），不做静默兜底。
 */
export function metricValue(
  name: string,
  totals: Totals,
  extra: Record<string, number>,
): [number, string] {
  if (!Object.prototype.hasOwnProperty.call(METRIC_WHITELIST, name)) {
    throw new Error(`KeyError: ${name}`);
  }
  const [fieldName, unit] = METRIC_WHITELIST[name];
  if (fieldName.startsWith('__')) {
    return [(extra[fieldName] ?? 0.0) as number, unit];
  }
  const raw = totals[fieldName] ?? 0;
  if (LATENCY_METRICS.has(name)) {
    // 时延类指标需要按权重平均而非求和（此处以记录条数近似加权）
    return [Number(raw), unit];
  }
  return [Number(raw), unit];
}

/** 对应 Python `bucket_seconds_for`。 */
export function bucketSecondsFor(days: number): number {
  if (days <= 2) {
    return 300;
  }
  if (days <= 7) {
    return 3600;
  }
  return 86400;
}

/**
 * 返回 `{ 分组值: [(日期, 值)] }`，稀疏（无数据日不产出）。对应 Python `daily_points`。
 *
 * 组内日期升序（`sorted(day_map.items())`）；分组键按首次出现顺序插入。
 */
export function dailyPoints(
  index: Index,
  start: string,
  end: string,
  field: string,
  group: string | null,
  userIds: Set<string> | null,
): Record<string, Array<[string, number]>> {
  const rows = [...iterRows(index, start, end, userIds ?? null)];
  let keyOf: (row: SeriesRow) => string;
  if (group === 'department') {
    keyOf = (row) => String(mapGet(index.deptOf, row.u, 'unknown'));
  } else if (group === 'user') {
    keyOf = (row) => {
      const meta = index.members.get(row.u);
      return meta === undefined || !('userName' in meta) ? row.u : String(meta.userName);
    };
  } else if (group !== null && Object.prototype.hasOwnProperty.call(ROW_DIM_FIELD, group)) {
    const src = ROW_DIM_FIELD[group];
    keyOf = (row) => String(row[src]);
  } else {
    keyOf = () => '__total__';
  }

  const buckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = keyOf(row);
    const day = row.d;
    let dayMap = buckets.get(key);
    if (dayMap === undefined) {
      dayMap = new Map<string, number>();
      buckets.set(key, dayMap);
    }
    dayMap.set(day, (dayMap.get(day) ?? 0.0) + Number(row[field]));
  }
  const out: Record<string, Array<[string, number]>> = {};
  for (const [key, dayMap] of buckets) {
    out[key] = [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 日期工具（纯整数运算，等价 Python `date` 的 proleptic Gregorian 语义；不涉及时区）
// ---------------------------------------------------------------------------

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Howard Hinnant 的 days_from_civil：返回相对 1970-01-01 的天数。 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** days_from_civil 的逆运算。 */
function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/**
 * 解析 ISO 日期（`YYYY-MM-DD` 或 `YYYYMMDD`，与 Python 3.11+ `date.fromisoformat`
 * 的这两种形式一致）为「相对 1970-01-01 的天数」。非法日期抛错（Python 抛 ValueError）。
 */
function parseIsoDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m === null) throw new RangeError(`Invalid isoformat string: '${s}'`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) throw new RangeError(`Invalid isoformat string: '${s}'`);
  const maxDay = mo === 2 && isLeapYear(y) ? 29 : MONTH_LENGTHS[mo - 1];
  if (d < 1 || d > maxDay) throw new RangeError(`Invalid isoformat string: '${s}'`);
  return daysFromCivil(y, mo, d);
}

function formatIsoDate(z: number): string {
  const { y, m, d } = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 对应 Python `date_range`：闭区间内逐日枚举；`end < start` 时返回空数组。 */
export function dateRange(start: string, end: string): string[] {
  const begin = parseIsoDate(start);
  const finish = parseIsoDate(end);
  const out: string[] = [];
  for (let i = 0; i < finish - begin + 1; i++) {
    out.push(formatIsoDate(begin + i));
  }
  return out;
}
