/**
 * 生成 AI 效能运营台所需的 mock 数据集。
 *
 * 本文件是 `ai-efficiency-console/backend/app/gen_mock.py`（472 行）的**逐行移植**，不是重新设计：
 * 函数划分、分支顺序、**随机数调用顺序**、字段写入顺序、JSON 键顺序都与 Python 版一一对应，
 * 注释里的 `gen_mock.py:Lxxx` 指向原文件行号，便于逐段对照。
 *
 * 设计要点（与 Python 版一致）
 * ---------------------------
 * 1. 数据模型严格对齐接口文档 `document.yaml` 的字段口径，字段名与文档保持一致。
 * 2. 粒度：成员 × 自然日。所有部门级 / 公司级指标都由成员日粒度**聚合**得出，
 *    保证「部门汇总之和 == 公司总量」。
 * 3. 确定性：固定随机种子 + 参考日 ⇒ 逐字节可复现。
 * 4. 零运行时依赖：只用 Node 内置模块。
 *
 * 移植中必须显式处理的差异（每条都是判断，不是随手改）
 * --------------------------------------------------
 *  1. **`round()`**：Python 是 round-half-even，且以 double 的**精确十进制值**为基准；
 *     JS 的 `Math.round()` 是 half-up（`Math.round(2.675*100)/100 === 2.68`）。
 *     全部改用同仓的 `pyround.ts`：无 ndigits 的 `round(x)` → `round0(x)`；
 *     带 ndigits 的 `round(x, n)` → 本文件的 `_round(x, n)`（内部 `pyRound`）。
 *  2. **`int(float)`**：Python 向零截断，JS 用 `Math.trunc`（`Math.floor` 对负数会错）。
 *  3. **JSON 序列化**：`json.dumps(payload, ensure_ascii=False, separators=(",", ":"))` 由
 *     本文件的 `jsonDumps` 复刻。关键差别是 Python 把 float 写成 `2.0`，而
 *     `JSON.stringify` 写成 `2` —— 下游用 Python `json.load` 解析时 `2.0`(float) 与
 *     `2`(int) 类型不同，所以 `PY_FLOAT_KEYS` 列出的字段必须写成 `x.0`。
 *  4. **`sum()`**：Python 3.12+（gh-100425）对 float 求和用 Neumaier 补偿求和，
 *     朴素左到右累加会给出略不同的结果，故用 `pySumFloats` 复刻（见该函数注释）。
 *  5. **`generatedAt`**：Python 写 `datetime.now(TZ)`（每次运行都不同），与
 *     「相同 seed + 相同参考日 ⇒ 逐字节相同」的要求冲突；这里改为由参考日推导的确定值。
 *  6. **`AEC_REFERENCE_DAY` 的时区**：沿用 Python 的本地时区语义（`date.today()`），
 *     而输出的时间戳固定带东八区偏移 `+08:00`（原文件的 `TZ` 常量）。
 *  7. **`Math.sin/log` 与 libm 的 1 ULP 差异**（`pyrandom.ts` 头部已声明）：数值可能与
 *     Python 版有极小偏差；但**随机数调用序列与所有分支判定完全一致**，因此记录条数、
 *     字段名集合、嵌套层级、键顺序与 Python 版逐字节同构。
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PyRandom } from './pyrandom.ts';
import { pyRound, round0 } from './pyround.ts';
// 只借 types.ts 的**形状**做收口校验；口径逻辑归 metrics.ts（见其文件头）。
import type { Dataset, Department, Member } from './types.ts';

// ---------------------------------------------------------------------------
// 常量（gen_mock.py:L30-L32）
// ---------------------------------------------------------------------------
const SEED = 20260920;
/** `TZ = timezone(timedelta(hours=8))`：东八区，与文档示例一致。 */
const TZ_SUFFIX = '+08:00';
/** 生成 180 天日粒度，足够支撑 7/30/90/自定义区间对比。 */
const WINDOW_DAYS = 180;

// ---------------------------------------------------------------------------
// 纯日期工具 —— Python `date` 用到的子集（只做「年月日 ↔ 天数」换算，不涉及时区换算；
// 时间串按原文件的固定 +08:00 偏移拼装）
// ---------------------------------------------------------------------------
interface PlainDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Howard Hinnant `days_from_civil`：1970-01-01 为第 0 天。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Howard Hinnant `civil_from_days`。 */
function civilFromDays(days: number): PlainDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function dateToDays(dt: PlainDate): number {
  return daysFromCivil(dt.year, dt.month, dt.day);
}

/** Python `date + timedelta(days=n)`。 */
function addDays(dt: PlainDate, days: number): PlainDate {
  return civilFromDays(dateToDays(dt) + days);
}

/** Python `(to - from).days`。 */
function diffDays(from: PlainDate, to: PlainDate): number {
  return dateToDays(to) - dateToDays(from);
}

/** Python `date.isoformat()`。 */
function isoDate(dt: PlainDate): string {
  return (
    `${String(dt.year).padStart(4, '0')}-` +
    `${String(dt.month).padStart(2, '0')}-` +
    `${String(dt.day).padStart(2, '0')}`
  );
}

/** Python `date.weekday()`：周一 = 0，周日 = 6。 */
function weekday(dt: PlainDate): number {
  return (((dateToDays(dt) + 3) % 7) + 7) % 7;
}

/** Python `date.replace(day=1)`。 */
function firstOfMonth(dt: PlainDate): PlainDate {
  return { year: dt.year, month: dt.month, day: 1 };
}

/** Python `date.fromisoformat()`：非法日期抛错，与 CPython 一样不做静默容错。 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseIsoDate(text: string): PlainDate {
  const matched = ISO_DATE_RE.exec(text);
  if (!matched) throw new Error(`Invalid isoformat string: '${text}'`);
  const candidate: PlainDate = {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
  };
  const back = civilFromDays(dateToDays(candidate));
  if (back.year !== candidate.year || back.month !== candidate.month || back.day !== candidate.day) {
    throw new Error(`day is out of range for month: '${text}'`);
  }
  return candidate;
}

/** Python `date.today()` —— 本地时区（Node 的 `Date` 取本地字段，行为与 Python 一致）。 */
function today(): PlainDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** `datetime.combine(d, time.min, TZ).isoformat()`。 */
function isoMidnight(dt: PlainDate): string {
  return `${isoDate(dt)}T00:00:00${TZ_SUFFIX}`;
}

/** `datetime.combine(d, time.min, TZ).replace(hour=..., minute=...).isoformat()`。 */
function isoAt(dt: PlainDate, hour: number, minute: number): string {
  return (
    `${isoDate(dt)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${TZ_SUFFIX}`
  );
}

/**
 * 确定数据窗口的「今天」（gen_mock.py:L35-L51）。
 *
 * 默认取**运行当天**（本地时区）：这样任何时间生成的看板都是「最近 180 天」。
 * 需要字节级可复现时用环境变量钉住：
 *     AEC_REFERENCE_DAY=2026-10-01 node backend/src/gen_mock.ts
 * 固定种子 SEED 只保证**数值**可复现，日期是另一维度，必须单独钉。
 */
function _resolve_reference_day(): PlainDate {
  const raw = (process.env.AEC_REFERENCE_DAY ?? '').trim();
  if (raw) return parseIsoDate(raw);
  return today();
}

export const REFERENCE_DAY: PlainDate = _resolve_reference_day();

// ---------------------------------------------------------------------------
// 组织架构（gen_mock.py:L53-L89）
// ---------------------------------------------------------------------------
const ENTERPRISE_ID = '1234567890';
const ENTERPRISE_NAME = '示例科技集团';

/** (id, 名称, 全路径, 上级, 语言画像, 生产力系数, AI 采纳强度, 人数) */
type DeptSpec = readonly [
  id: string,
  name: string,
  fullPath: string,
  parent: string | null,
  langs: readonly string[] | null,
  prod: number,
  adopt: number,
  headcount: number,
];

const DEPARTMENTS: readonly DeptSpec[] = [
  ['dept-root', '示例科技集团', '示例科技集团', null, null, 0.0, 0.0, 0],
  ['dept-001', '平台研发中心', '示例科技集团/平台研发中心', 'dept-root', ['Go', 'Python', 'SQL'], 1.28, 1.32, 12],
  ['dept-002', '客户端研发部', '示例科技集团/客户端研发部', 'dept-root', ['TypeScript', 'Swift', 'Kotlin'], 1.16, 1.18, 9],
  ['dept-003', '数据与算法部', '示例科技集团/数据与算法部', 'dept-root', ['Python', 'SQL'], 1.10, 1.45, 8],
  ['dept-004', '产品设计部', '示例科技集团/产品设计部', 'dept-root', ['TypeScript', 'Markdown'], 0.82, 0.94, 6],
  ['dept-005', '质量保障部', '示例科技集团/质量保障部', 'dept-root', ['Python', 'TypeScript'], 0.92, 1.06, 7],
  ['dept-006', '企业服务与运营', '示例科技集团/企业服务与运营', 'dept-root', ['Java', 'SQL', 'Markdown'], 0.74, 0.78, 6],
];

const DEPARTMENT_BY_ID = new Map<string, DeptSpec>(
  DEPARTMENTS.map((d): [string, DeptSpec] => [d[0], d]),
);

/** 各语言在「新增代码字符数 / 行数」上的平均密度，用于让字符数与行数自洽。 */
const LANG_CHARS_PER_LINE: Record<string, number> = {
  Go: 34, Java: 37, TypeScript: 32, Python: 29,
  Swift: 33, Kotlin: 34, SQL: 41, Markdown: 52,
};

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜';
const GIVEN_NAMES: readonly string[] = [
  '嘉树', '子墨', '宇航', '思远', '晨曦', '雨桐', '若冰', '文轩', '梓涵', '沐辰',
  '一鸣', '子瑜', '亦舟', '悠然', '知微', '折枝', '南乔', '北辰', '清和', '白露',
  '疏影', '观棋', '长歌', '星野', '云舒', '予安', '承宇', '宁远', '振宇', '静姝',
];

const CLIENTS: readonly string[] = ['VSCode', 'JetBrains', 'WorkBuddy', 'Web', 'CLI'];
const CLIENT_WEIGHTS: readonly number[] = [0.52, 0.18, 0.16, 0.09, 0.05];
const PLUGIN_VERSIONS: readonly string[] = ['v5.18.2', 'v5.19.0', 'v5.20.1', 'v5.20.3'];
const PLUGIN_WEIGHTS: readonly number[] = [0.12, 0.23, 0.31, 0.34];
const MODELS: readonly string[] = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-lite', 'claude-sonnet-4.6', 'gpt-5.2-codex',
];
const MODEL_WEIGHTS: readonly number[] = [0.46, 0.22, 0.14, 0.11, 0.07];

// ---------------------------------------------------------------------------
// 舍入与通用小工具（gen_mock.py:L92-L110）
// ---------------------------------------------------------------------------

/**
 * `gen_mock.py` 的 `_round(value, digits=4)`：`round(value + 1e-9, digits)`。
 *
 * 注意它返回的是 **float**（Python 里带 ndigits 的 `round` 恒返回 float），
 * 因此 `12.0` 必须序列化成 `12.0` 而不是 `12` —— 见 `PY_FLOAT_KEYS`。
 */
function _round(value: number, digits = 4): number {
  return pyRound(value + 1e-9, digits);
}

function _clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Python `_is_weekend(day)`：`day.weekday() >= 5`。 */
function _is_weekend(day: PlainDate): boolean {
  return weekday(day) >= 5;
}

/** 线性爬坡：t 归一化到 [0,1]（gen_mock.py:L108-L110）。 */
function _ramp(t: number, start: number, end: number): number {
  return start + (end - start) * _clamp(t, 0.0, 1.0);
}

/** Python `random.choices(items, weights=w, k=1)[0]`。 */
function _weighted<T>(rng: PyRandom, items: readonly T[], weights: readonly number[]): T {
  return rng.choicesWeighted(items, weights);
}

/** Python `random.choice(str)`：pyrandom 的重载签名对 string 需要断言成 string。 */
function choiceChar(rng: PyRandom, text: string): string {
  return rng.choice(text) as string;
}

/** Python `f"{n:0{width}x}"`。 */
function hexPad(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

/**
 * Python 3.12+ `sum()` 对 float 使用 Neumaier 补偿求和（gh-100425），
 * 朴素的左到右累加会得到略不同的结果。这里照搬该算法：
 * 逐项累加，同时用 `c` 记录被舍掉的低位，最后一次性补回。
 */
function pySumFloats(values: readonly number[]): number {
  let total = 0.0;
  let compensation = 0.0;
  for (const value of values) {
    const t = total + value;
    if (Math.abs(total) >= Math.abs(value)) compensation += (total - t) + value;
    else compensation += (value - t) + total;
    total = t;
  }
  return total + compensation;
}

// ---------------------------------------------------------------------------
// 成员对象的形状
// ---------------------------------------------------------------------------
/**
 * 生成期的成员对象。
 *
 * 与 `types.ts` 的 `Member` 有两处**刻意的**差别，都是为了如实反映 Python 的输出：
 *   - 聚合派生字段（lastActiveTime / activeDays / …）在 `build_org` 阶段还不存在，
 *     故此处可选；它们在 `generate()` 末尾按 Python 的两条分支写入。
 *   - `cycleLimit` 在 Python 里可以是 `None`（`index % 10 === 3` 的成员「不限量」，
 *     参考数据集里确有 5 个 `"cycleLimit":null`），而 `types.ts` 把它标成 `number`。
 *     这里按事实声明为 `number | null`，在 `generate()` 收口处做一次断言。
 */
type GenMember = {
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
  // —— 隐藏的生成参数（不直接暴露给页面，供生成器内部使用）——
  _prod: number;
  _adopt: number;
  _lang: string;
  _dormant: boolean;
  _joinedOffset: number;
  _activityBias: number;
  // —— 下列字段由 generate() 末尾补齐（Python 里的 member.update({...})）——
  lastActiveTime?: string | null;
  activeDays?: number;
  dialogCount?: number;
  completionGenerateCount?: number;
  completionAcceptCount?: number;
  completionAcceptRateByCount?: number;
  completionGenerateLines?: number;
  completionAcceptLines?: number;
  completionAcceptRateByLines?: number;
  completionGenerateChars?: number;
  completionAcceptChars?: number;
  completionAcceptRateByChars?: number;
  aiGenerateCodeLines?: number;
  totalNewCodeLines?: number;
  codeGenerateRateByLines?: number;
  aiGenerateCodeChars?: number;
  totalNewCodeChars?: number;
  codeGenerateRateByChars?: number;
  totalUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cycleLimit?: number | null;
  cycleLimitDisplay?: string;
};

/**
 * 生成期的日粒度记录。
 *
 * 字段类型比 `types.ts` 的 `SeriesRow`（面向口径层的宽松索引签名）更精确，
 * 这样 `bucket[key] += row[key]` 之类可以做静态检查。
 * 这里用 `type` 而不是 `interface` 是有意的：类型别名会获得**隐式索引签名**，
 * 因此 `GenSeriesRow[]` 可以直接赋给 `SeriesRow[]`，无需断言。
 */
type GenSeriesRow = {
  d: string;
  u: string;
  // 代码补全
  cg: number;
  ca: number;
  cgl: number;
  cal: number;
  cgc: number;
  cac: number;
  // 对话
  dc: number;
  dk: number;
  dcr: number;
  dcy: number;
  dcm: number;
  dct: number;
  da: number;
  dkb: number;
  dac: number;
  // 代码量
  ail: number;
  tnl: number;
  aic: number;
  tnc: number;
  // 成本
  cr: number;
  crc: number;
  it: number;
  ot: number;
  cri: number;
  // 会话与可观测
  sc: number;
  rq: number;
  err: number;
  tc: number;
  te: number;
  ttft: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  dur: number;
  dp50: number;
  dp95: number;
  sdur: number;
  srd: number;
  // 客户端 / 插件 / 模型（维度拆解）
  cl: string;
  pv: string;
  md: string;
  lg: string;
};

// ---------------------------------------------------------------------------
// 构造部门与成员名册（gen_mock.py:L113-L170）
// ---------------------------------------------------------------------------
function buildOrg(rng: PyRandom): { departments: Department[]; members: GenMember[] } {
  const departments: Department[] = [];
  for (const spec of DEPARTMENTS) {
    const [deptId, name, fullPath, parent] = spec;
    departments.push({
      departmentId: deptId,
      departmentName: name,
      fullPath,
      parentId: parent,
      level: parent === null ? 0 : parent === 'dept-root' ? 1 : 2,
      status: 'enabled',
    });
  }

  const members: GenMember[] = [];
  const usedNames = new Set<string>();
  for (const spec of DEPARTMENTS) {
    const [deptId, name, , , langs, prod, adopt, headcount] = spec;
    if (headcount === 0) continue;
    for (let index = 0; index < headcount; index++) {
      // Python 是 `while True` 重抽，直到姓名不重复
      let userName = '';
      for (;;) {
        const given = rng.choice(GIVEN_NAMES);
        const surname = choiceChar(rng, SURNAMES);
        userName = `${surname}${given}`;
        if (!usedNames.has(userName)) {
          usedNames.add(userName);
          break;
        }
      }
      // 8 位成员为窗口期内新入职，用于体现「新人爬坡」
      const isNewJoiner = rng.random() < 0.16;
      const joinedOffset = isNewJoiner
        ? rng.randint(20, 130)
        : rng.randint(WINDOW_DAYS + 60, WINDOW_DAYS + 900);
      const joinedAt = addDays(REFERENCE_DAY, -joinedOffset);
      // 每个部门固定留 1 位长期不活跃成员，便于验证空态与提醒
      const dormant = members.length % 16 === 15;
      const primaryLang = rng.choice(langs!);
      // 下面这个字面量的求值顺序 == Python dict 字面量的求值顺序，
      // 也就是 userId 里的 6 次随机调用 → _prod → _adopt → _activityBias，不能调换。
      members.push({
        // 单参 randrange(stop) 与 Python 源码逐字对应（pyrandom.ts 已支持两种形式）
        userId:
          `${hexPad(rng.randrange(16 ** 8), 8)}-${hexPad(rng.randrange(16 ** 4), 4)}-` +
          `4${hexPad(rng.randrange(16 ** 3), 3)}-${choiceChar(rng, '89ab')}` +
          `${hexPad(rng.randrange(16 ** 3), 3)}-${hexPad(rng.randrange(16 ** 12), 12)}`,
        userName,
        userNickname: userName,
        email: `user${String(members.length + 1).padStart(3, '0')}@example.com`,
        primaryDepartmentId: deptId,
        primaryDepartmentName: name,
        departmentFullPath: DEPARTMENT_BY_ID.get(deptId)![2],
        departmentIds: [deptId],
        departmentNames: [name],
        departmentFullPaths: [DEPARTMENT_BY_ID.get(deptId)![2]],
        joinedAt: isoMidnight(joinedAt),
        _prod: prod * rng.uniform(0.62, 1.55),
        _adopt: adopt * rng.uniform(0.72, 1.34),
        _lang: primaryLang,
        _dormant: dormant,
        _joinedOffset: joinedOffset,
        _activityBias: rng.uniform(0.75, 1.3),
      });
    }
  }
  return { departments, members };
}

// ---------------------------------------------------------------------------
// 生成数据集（gen_mock.py:L173-L449）
// ---------------------------------------------------------------------------
export function generate(): Dataset {
  const rng = new PyRandom(SEED);
  const { departments, members } = buildOrg(rng);

  const startDay = addDays(REFERENCE_DAY, -(WINDOW_DAYS - 1));
  const days: PlainDate[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) days.push(addDays(startDay, i));

  // 公司级 AI 使用渗透曲线：180 天内从 0.6 爬到 1.15，叠加月度波动
  const companyCurve = (dayIndex: number): number => {
    const base = _ramp(dayIndex / (WINDOW_DAYS - 1), 0.6, 1.15);
    // 乘法顺序必须与 Python 一致：((d/30)*2)*pi，不能"优化"成 (d/30)*(2*pi)
    const monthly = 1.0 + 0.05 * Math.sin((dayIndex / 30.0) * 2 * Math.PI);
    return base * monthly;
  };

  const series: GenSeriesRow[] = [];
  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const day = days[dayIndex];
    const weekend = _is_weekend(day);
    const weekendFactor = weekend ? 0.17 : rng.uniform(0.93, 1.08);
    const curve = companyCurve(dayIndex);
    for (const member of members) {
      if (dateToDays(day) < dateToDays(startDay)) continue; // Python 原样保留的恒假分支
      const joinedDay = addDays(REFERENCE_DAY, -member._joinedOffset);
      // 入职前无数据
      if (dateToDays(day) < dateToDays(joinedDay)) continue;
      // 长期不活跃：近 40 天零使用，但历史仍有基线
      if (member._dormant && diffDays(day, REFERENCE_DAY) < 40) continue;
      if (rng.random() < 0.04) continue; // 当天无任何 AI 行为

      const tenure_days = diffDays(joinedDay, day);
      const tenure_factor = _ramp(tenure_days / 45.0, 0.35, 1.0);

      // 「活跃强度」：驱动所有绝对量指标，保证各指标同向变化
      // 各因子相乘顺序与 Python 的左结合顺序一致（浮点乘法不可交换律近似）。
      let intensity =
        member._prod * member._activityBias * tenure_factor *
        curve * weekendFactor * rng.uniform(0.55, 1.4);
      intensity = Math.max(intensity, 0.05);

      const chars_per_line = LANG_CHARS_PER_LINE[member._lang] ?? 33;

      // —— 代码补全 ——
      const comp_gen = Math.max(0, round0(rng.gauss(58, 9) * intensity));
      const comp_accept = round0(
        comp_gen * _clamp(rng.gauss(0.29, 0.05) * member._adopt, 0.02, 0.72),
      );
      // 下面三个 rate 在 Python 里算了但没写进数据集（原文件如此），保留以对齐行序
      const comp_rate = comp_gen ? _round((comp_accept / comp_gen) * 100, 2) : 0.0;
      const comp_gen_lines = round0(comp_gen * rng.uniform(1.1, 2.4));
      const comp_gen_chars = round0(comp_gen_lines * chars_per_line * rng.uniform(0.7, 1.15));
      const comp_accept_lines = comp_gen ? round0((comp_gen_lines * comp_accept) / comp_gen) : 0;
      const comp_accept_chars = comp_gen ? round0((comp_gen_chars * comp_accept) / comp_gen) : 0;
      const comp_line_rate = comp_gen_lines ? _round((comp_accept_lines / comp_gen_lines) * 100, 2) : 0.0;
      const comp_char_rate = comp_gen_chars ? _round((comp_accept_chars / comp_gen_chars) * 100, 2) : 0.0;

      // —— 对话 ——
      const dialog = Math.max(0, round0(rng.gauss(15, 3.4) * intensity));
      const ask = round0(dialog * rng.uniform(0.18, 0.34));
      const craft = round0(dialog * rng.uniform(0.24, 0.4));
      const agent = round0(dialog * rng.uniform(0.06, 0.2));
      const knowledge = round0(dialog * rng.uniform(0.03, 0.12));
      const context = round0(dialog * rng.uniform(0.02, 0.09));
      const command = round0(dialog * rng.uniform(0.01, 0.06));
      const action = round0(dialog * rng.uniform(0.0, 0.03));
      const custom = round0(dialog * rng.uniform(0.0, 0.04));

      // —— 代码生成量（AI 生成 vs 新增总量）——
      const target_rate = _clamp(0.72 * member._adopt * rng.uniform(0.82, 1.14), 0.18, 0.965);
      const total_lines = Math.max(1, comp_accept_lines + round0(rng.gauss(46, 11) * intensity));
      const ai_lines = round0(total_lines * target_rate);
      const total_chars = round0(total_lines * chars_per_line * rng.uniform(0.82, 1.22));
      const ai_chars = round0(total_chars * target_rate * rng.uniform(0.94, 1.06));
      const gen_rate_lines = _round((ai_lines / total_lines) * 100, 2); // 未写入数据集（同 Python）
      const gen_rate_chars = total_chars ? _round((ai_chars / total_chars) * 100, 2) : 0.0; // 同上

      // —— token 与 Credits 消耗（成本敞口）——
      const input_tokens = round0(dialog * rng.uniform(1500, 3400) + comp_gen * rng.uniform(20, 45));
      const output_tokens = round0(dialog * rng.uniform(320, 780) + comp_accept * rng.uniform(28, 62));
      const cache_read = round0(input_tokens * rng.uniform(0.16, 0.44));
      const credit = _round(
        dialog * rng.uniform(2.4, 5.1) +
          comp_gen * rng.uniform(0.05, 0.11) +
          (output_tokens / 1000.0) * rng.uniform(0.55, 0.95),
        2,
      );
      const credit_cost = _round(credit * 0.0126, 4);

      // —— 会话 / 请求 / 工具调用（可观测域）——
      const session_count = Math.max(1, round0(dialog / rng.uniform(2.4, 4.2)));
      const request_count = dialog + Math.max(0, round0(comp_gen * rng.uniform(0.02, 0.06)));
      const error_count = rng.random() < 0.018 ? 1 : 0;
      const tool_calls = round0(agent * rng.uniform(1.4, 4.6)) + (rng.random() < 0.3 ? 1 : 0);
      // Python 是 `tool_calls and rng.random() < 0.03`：tool_calls 为 0 时**不调用** rng
      const tool_errors = tool_calls !== 0 && rng.random() < 0.03 ? 1 : 0;
      const ttft_avg = round0(rng.gauss(680, 90) * (1.0 + Math.max(0.0, 0.85 - curve) * 0.5));
      const p50 = round0(ttft_avg * rng.uniform(0.72, 0.86));
      const p90 = round0(ttft_avg * rng.uniform(1.9, 2.5));
      const p95 = round0(p90 * rng.uniform(1.1, 1.28));
      const p99 = round0(p95 * rng.uniform(1.12, 1.35));
      const duration_avg = round0(rng.gauss(3200, 600) * (1.0 + intensity * 0.06));
      const duration_p50 = round0(duration_avg * rng.uniform(0.6, 0.75));
      const duration_p95 = round0(duration_avg * rng.uniform(2.0, 2.8));
      const session_duration = round0(session_count * rng.uniform(210, 640));
      const session_rounds = _round(dialog / session_count, 2);

      series.push({
        d: isoDate(day),
        u: member.userId,
        // 代码补全
        cg: comp_gen,
        ca: comp_accept,
        cgl: comp_gen_lines,
        cal: comp_accept_lines,
        cgc: comp_gen_chars,
        cac: comp_accept_chars,
        // 对话
        dc: dialog,
        dk: ask,
        dcr: craft,
        dcy: custom,
        dcm: command,
        dct: context,
        da: agent,
        dkb: knowledge,
        dac: action,
        // 代码量
        ail: ai_lines,
        tnl: total_lines,
        aic: ai_chars,
        tnc: total_chars,
        // 成本
        cr: credit,
        crc: credit_cost,
        it: input_tokens,
        ot: output_tokens,
        cri: cache_read,
        // 会话与可观测
        sc: session_count,
        rq: request_count,
        err: error_count,
        tc: tool_calls,
        te: tool_errors,
        ttft: ttft_avg,
        p50,
        p90,
        p95,
        p99,
        dur: duration_avg,
        dp50: duration_p50,
        dp95: duration_p95,
        sdur: session_duration,
        srd: session_rounds,
        // 客户端 / 插件 / 模型（维度拆解）
        cl: _weighted(rng, CLIENTS, CLIENT_WEIGHTS),
        pv: _weighted(rng, PLUGIN_VERSIONS, PLUGIN_WEIGHTS),
        md: _weighted(rng, MODELS, MODEL_WEIGHTS),
        lg: member._lang,
      });
    }
  }

  // 补齐成员维度派生字段（由日粒度聚合，口径与文档 L1828-L1923 一致）
  const SUM_KEYS = [
    'cg', 'ca', 'cgl', 'cal', 'cgc', 'cac', 'dc', 'ail', 'tnl', 'aic', 'tnc', 'it', 'ot',
  ] as const;
  interface SeriesBucket {
    cg: number;
    ca: number;
    cgl: number;
    cal: number;
    cgc: number;
    cac: number;
    dc: number;
    ail: number;
    tnl: number;
    aic: number;
    tnc: number;
    cr: number;
    it: number;
    ot: number;
    last: string | null;
    active: Set<string>;
  }

  const agg = new Map<string, SeriesBucket>();
  for (const row of series) {
    let bucket = agg.get(row.u);
    if (bucket === undefined) {
      bucket = {
        cg: 0, ca: 0, cgl: 0, cal: 0, cgc: 0, cac: 0, dc: 0, ail: 0, tnl: 0, aic: 0, tnc: 0,
        cr: 0.0, it: 0, ot: 0, last: null, active: new Set<string>(),
      };
      agg.set(row.u, bucket);
    }
    for (const key of SUM_KEYS) bucket[key] = bucket[key] + row[key];
    bucket.cr += row.cr;
    if (bucket.last === null || row.d > bucket.last) bucket.last = row.d;
    bucket.active.add(row.d);
  }

  for (const member of members) {
    const bucket = agg.get(member.userId);
    if (bucket === undefined) {
      // 窗口内完全无行为的成员：字段置零，便于前端展示冷启动状态
      // 注意：Python 这条分支**不写** inputTokens / outputTokens。
      Object.assign(member, {
        lastActiveTime: null,
        activeDays: 0,
        dialogCount: 0,
        completionGenerateCount: 0,
        completionAcceptCount: 0,
        completionAcceptRateByCount: 0.0,
        completionGenerateLines: 0,
        completionAcceptLines: 0,
        completionAcceptRateByLines: 0.0,
        completionGenerateChars: 0,
        completionAcceptChars: 0,
        completionAcceptRateByChars: 0.0,
        aiGenerateCodeLines: 0,
        totalNewCodeLines: 0,
        codeGenerateRateByLines: 0.0,
        aiGenerateCodeChars: 0,
        totalNewCodeChars: 0,
        codeGenerateRateByChars: 0.0,
        totalUsed: 0.0,
      });
    } else {
      const pct = (num: number, den: number): number => (den ? _round((num / den) * 100, 2) : 0.0);
      // 键的写入顺序与 Python 的 member.update({...}) 一致 —— 它决定 JSON 键顺序。
      Object.assign(member, {
        lastActiveTime: isoAt(parseIsoDate(bucket.last!), 17, 42),
        activeDays: bucket.active.size,
        dialogCount: bucket.dc,
        completionGenerateCount: bucket.cg,
        completionAcceptCount: bucket.ca,
        completionAcceptRateByCount: pct(bucket.ca, bucket.cg),
        completionGenerateLines: bucket.cgl,
        completionAcceptLines: bucket.cal,
        completionAcceptRateByLines: pct(bucket.cal, bucket.cgl),
        completionGenerateChars: bucket.cgc,
        completionAcceptChars: bucket.cac,
        completionAcceptRateByChars: pct(bucket.cac, bucket.cgc),
        aiGenerateCodeLines: bucket.ail,
        totalNewCodeLines: bucket.tnl,
        codeGenerateRateByLines: pct(bucket.ail, bucket.tnl),
        aiGenerateCodeChars: bucket.aic,
        totalNewCodeChars: bucket.tnc,
        codeGenerateRateByChars: pct(bucket.aic, bucket.tnc),
        totalUsed: _round(bucket.cr, 2),
        inputTokens: bucket.it,
        outputTokens: bucket.ot,
      });
    }
  }

  // 周期限量：口径必须与「额度周期」对齐（自然月），因此用**当月消耗**推导，
  // 而不是用 180 天窗口消耗，否则看板窗口与额度周期错配、风险档位失真。
  const cycle_prefix = isoDate(firstOfMonth(REFERENCE_DAY));
  const month_used = new Map<string, number>();
  for (const row of series) {
    if (row.d >= cycle_prefix) {
      month_used.set(row.u, (month_used.get(row.u) ?? 0.0) + row.cr);
    }
  }

  for (let index = 0; index < members.length; index++) {
    const member = members[index];
    const base = month_used.get(member.userId) ?? 0.0;
    if (index % 10 === 3) {
      member.cycleLimit = null;
      member.cycleLimitDisplay = '不限量';
    } else {
      // 系数分布：<1.05 超限风险、1.05~1.4 偏高、>1.4 正常
      let factor: number;
      if (index % 5 === 4) factor = 0.95;
      else if (index % 3 === 0) factor = 1.22;
      else factor = 1.85;
      const limit = Math.trunc(base * factor) + 30; // Python int(float) 向零截断
      member.cycleLimit = limit;
      member.cycleLimitDisplay = String(limit);
    }
  }

  // 计算当前额度周期（自然月口径，与 usage/quota-cycle 对齐）
  const cycle_start = firstOfMonth(REFERENCE_DAY);
  const next_month = firstOfMonth(addDays(cycle_start, 32));
  const quota_cycle = {
    cycleType: 'MONTHLY',
    cycleMode: 'natural_month',
    cycleStart: isoMidnight(cycle_start),
    cycleEnd: isoMidnight(next_month),
    nextCycleStart: isoMidnight(next_month),
  };

  // 资源概览：积分 + 席位（与 resources/overview 对齐）
  const total_credit = pySumFloats(series.map((row) => row.cr));
  const license_total = members.length + 24;
  const license_used = members.reduce((acc, m) => acc + (m.lastActiveTime ? 1 : 0), 0);
  const resources = {
    enterpriseId: ENTERPRISE_ID,
    items: [
      {
        resourceType: 'credit',
        unit: 'credit',
        total: Math.trunc(total_credit * 1.42),
        used: Math.trunc(total_credit),
        remaining: Math.trunc(total_credit * 0.42),
        remainingRatio: 0.42,
        sources: [
          {
            sourceType: 'fixedPackage',
            name: '订阅包（当期）',
            total: Math.trunc(total_credit * 1.2),
            used: Math.trunc(total_credit * 0.86),
            currentPeriodStart: quota_cycle.cycleStart,
            currentPeriodEnd: quota_cycle.cycleEnd,
            resetAt: quota_cycle.cycleEnd,
          },
          {
            sourceType: 'additionalPackage',
            name: '加量包 A',
            total: Math.trunc(total_credit * 0.12),
            used: Math.trunc(total_credit * 0.1),
            effectiveAt: quota_cycle.cycleStart,
            expiresAt: quota_cycle.cycleEnd,
          },
          {
            sourceType: 'enterpriseGiftPackage',
            name: '企业赠送包',
            total: Math.trunc(total_credit * 0.1),
            used: Math.trunc(total_credit * 0.04),
            effectiveAt: quota_cycle.cycleStart,
            expiresAt: quota_cycle.cycleEnd,
          },
        ],
      },
      {
        resourceType: 'license',
        unit: 'seat',
        total: license_total,
        used: license_used,
        remaining: license_total - license_used,
        remainingRatio: _round((license_total - license_used) / license_total, 4),
      },
    ],
  };

  // 默认成员额度
  const default_quota = {
    cycleType: 'MONTHLY',
    cycleLimit: 12000,
    cycleMode: quota_cycle.cycleMode,
    cycleStart: quota_cycle.cycleStart,
    cycleEnd: quota_cycle.cycleEnd,
    nextCycleStart: quota_cycle.nextCycleStart,
  };

  const payload: Dataset = {
    meta: {
      // Python 此处是 `datetime.now(TZ)`，每次运行都不同（生成的看板因此带上"新鲜"时间戳）。
      // 但那与「相同 seed + 相同参考日 ⇒ 逐字节相同」的确定性要求不可兼得，
      // 因此这里改成由参考日推导的确定值。唯一变化的是这个字段的取值，
      // 类型/键/位置与 Python 版完全一致（parity 测试台也把 generatedAt 列为 volatile）。
      generatedAt: isoMidnight(REFERENCE_DAY),
      referenceDay: isoDate(REFERENCE_DAY),
      windowDays: WINDOW_DAYS,
      seed: SEED,
      enterpriseId: ENTERPRISE_ID,
      enterpriseName: ENTERPRISE_NAME,
      note: '全部数值为 mock 数据，用于接口未就绪阶段的联调与视觉验收',
    },
    departments,
    // 断言收口：`GenMember` 的派生字段是**可选**的（它们由下面的聚合循环逐字段写入，
    // 与 Python 的 member.update 一一对应），类型系统无法知道此处已补齐。
    // 运行时形状与 Member 一致（cycleLimit 现已是 number | null）。
    members: members as unknown as Member[],
    quotaCycle: quota_cycle,
    defaultQuota: default_quota,
    // types.ts 的 ResourceItem 要求必有 sources，但 Python 的 license 条目没有该键；
    // 同样如实产出，收口断言一次。
    resources: resources as unknown as Dataset['resources'],
    series,
  };
  return payload;
}

// ---------------------------------------------------------------------------
// JSON 序列化：复刻 `json.dumps(payload, ensure_ascii=False, separators=(",", ":"))`
// ---------------------------------------------------------------------------
/**
 * Python 里是 **float** 的字段名集合。
 *
 * JSON 本身只有一种 number，但 Python 的 `json.dumps` 会把 float 写成 `2.0`、
 * 把 int 写成 `2`；下游用 Python `json.load` 解析时这两者分别是 float / int。
 * `JSON.stringify` 一律写成 `2`，会让这些字段的**数值类型**与 Python 版不一致，
 * 所以这里按字段名恢复。
 *
 * 来源（gen_mock.py）：
 *   - `_round(...)` 的产物（带 ndigits 的 round 恒返回 float）：
 *     series.cr/crc/srd、members 的 6 个 rate 字段与 totalUsed、license.remainingRatio
 *   - float 字面量：credit 条目的 remainingRatio(0.42)、members 的 _prod/_adopt/_activityBias
 * 这些字段名在整个数据集里互不冲突（已逐字段核对），故按键名判定是安全的。
 */
const PY_FLOAT_KEYS = new Set<string>([
  'cr', 'crc', 'srd',
  '_prod', '_adopt', '_activityBias',
  'completionAcceptRateByCount', 'completionAcceptRateByLines', 'completionAcceptRateByChars',
  'codeGenerateRateByLines', 'codeGenerateRateByChars', 'totalUsed',
  'remainingRatio',
]);

/**
 * Python `repr(float)` 的等价输出（最短往返十进制表示 + 至少一位小数）。
 *
 * JS 的 `Number.prototype.toString` 与 Python 的 `repr` 都给出**最短且正确舍入**的
 * 十进制数字串（位数一致），差别只在指数写法阈值：Python 在 `decpt <= -4 || decpt > 16`
 * 时用科学计数法（`1e+16`），JS 要到 1e21 才用。这里统一按 Python 规则排版。
 */
function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';

  const negative = value < 0;
  const text = Math.abs(value).toString();
  let mantissa = text;
  let exp10 = 0;
  const expAt = text.indexOf('e');
  if (expAt >= 0) {
    mantissa = text.slice(0, expAt);
    exp10 = Number(text.slice(expAt + 1));
  }
  const dotAt = mantissa.indexOf('.');
  let digits: string;
  let decpt: number;
  if (dotAt >= 0) {
    digits = mantissa.slice(0, dotAt) + mantissa.slice(dotAt + 1);
    decpt = dotAt + exp10;
  } else {
    digits = mantissa;
    decpt = mantissa.length + exp10;
  }
  // 去掉前导零（小数点位置同步左移）与尾随零
  let lead = 0;
  while (lead < digits.length - 1 && digits[lead] === '0') lead++;
  digits = digits.slice(lead);
  decpt -= lead;
  digits = digits.replace(/0+$/, '');
  if (digits === '') digits = '0';

  const useExp = decpt <= -4 || decpt > 16;
  let body: string;
  if (useExp) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const exp = decpt - 1;
    body = `${head}${tail ? `.${tail}` : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  } else if (decpt <= 0) {
    body = `0.${'0'.repeat(-decpt)}${digits}`;
  } else if (decpt >= digits.length) {
    body = `${digits}${'0'.repeat(decpt - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return negative ? `-${body}` : body;
}

/** 复刻 `json.dumps(obj, ensure_ascii=False, separators=(",", ":"))`（含键顺序）。 */
export function jsonDumps(value: unknown, key?: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // PY_FLOAT_KEYS 里的字段即便取到整数值也要写成 `12.0`
      if (key !== undefined && PY_FLOAT_KEYS.has(key)) return pyFloatRepr(value);
      return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => jsonDumps(item)).join(',')}]`;
      }
      const parts: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue; // 与 JSON.stringify 一致：跳过 undefined
        parts.push(`${JSON.stringify(k)}:${jsonDumps(v, k)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`无法序列化为 JSON: ${String(value)}`);
  }
}

// ---------------------------------------------------------------------------
// CLI 入口（gen_mock.py:L452-L472）
// ---------------------------------------------------------------------------
/** 仓库根 = backend/src → backend → <root>，对应 `Path(__file__).resolve().parents[2]`。 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const OUT_PATH = resolve(ROOT, 'data', 'mock_dataset.json');

/** Python `format(value, f".{digits}f")`：round-half-even 后定点输出。 */
function fixed(value: number, digits: number): string {
  return pyRound(value, digits).toFixed(digits);
}

/** Python `format(value, ",.0f")`：round-half-even 到整数 + 千分位。 */
function groupInt(value: number): string {
  return String(pyRound(value, 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function main(): void {
  const out = OUT_PATH;
  mkdirSync(dirname(out), { recursive: true });
  const payload = generate();
  // Python 的 json.dumps 不写尾随换行，这里也不写（保证逐字节可比的落盘形式）
  writeFileSync(out, jsonDumps(payload), 'utf8');

  const size_kb = statSync(out).size / 1024;
  const members = payload.members;
  console.log(`[OK] ${out}  (${fixed(size_kb, 0)} KB)`);
  console.log(
    `     部门 ${payload.departments.length - 1} 个 / 成员 ${members.length} 人 / ` +
      `日粒度记录 ${payload.series.length} 条`,
  );
  console.log(`      窗口 ${payload.meta.referenceDay} 往前 ${WINDOW_DAYS} 天`);
  const total_lines = members.reduce((acc, m) => acc + (m.totalNewCodeLines ?? 0), 0);
  const ai_lines = members.reduce((acc, m) => acc + (m.aiGenerateCodeLines ?? 0), 0);
  const credit = pySumFloats(members.map((m) => m.totalUsed ?? 0));
  console.log(
    `      新增代码 ${groupInt(total_lines)} 行 / AI 生成 ${groupInt(ai_lines)} 行 ` +
      `(占比 ${fixed((ai_lines / total_lines) * 100, 1)}%) / Credits ${groupInt(credit)}`,
  );
}

main();
