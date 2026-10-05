# AI 效能运营台（TypeScript 全栈版）

面向研发管理者的**部门级 AI 用量与代码贡献占比分析看板**。
本目录是 `ai-efficiency-console/`（Python 后端 + React/TS 前端）的**前后端统一 TypeScript** 版本。

---

## 1. 和 Python 版的关系

| | Python 版 | 本版 |
|---|---|---|
| 后端语言 | Python 3（仅标准库） | **TypeScript（仅 Node 内置模块）** |
| 前端 | React 18 + TS + Vite | 同左（代码原样复用，未改） |
| 运行时依赖 | 0 | **0**（后端不引任何 npm 运行时包） |
| 后端构建步骤 | 无 | **无**（Node 原生执行 `.ts`） |
| 指标口径 | `metrics.py` | `metrics.ts`（唯一实现） |
| mock 数据 | `gen_mock.py` | `gen_mock.ts`（种子化，可复现） |

**Python 版保持原样不动**，作为对照基准 —— 口径等价性测试要同时跑两边。

### 为什么是「零依赖」

Python 版有一条硬性原则：后端 327+1503+472 行全部只用标准库，不引 `requirements.txt`。
本版刻意延续这条原则：后端只用 `node:http` / `node:fs` / `node:crypto` 等内置模块，
不引 Express / Fastify / Hono。换来的是极简部署与不会有依赖腐化。

### 为什么没有构建步骤

Node 22.6+ 支持原生执行 TypeScript（类型擦除）。本版直接用 `node backend/src/server.ts` 运行，
不需要 `tsc` 编译或 `tsx` 之类的中介。代价是**只能用可擦除语法**：
禁止 `enum`、`namespace`、构造函数参数属性、装饰器（`tsconfig.json` 里用
`erasableSyntaxOnly: true` 把这些钉死，写错会在类型检查阶段报错）。
类型检查仍然独立执行（`npm run typecheck`），只是不产出 JS。

---

## 2. 快速开始

```bash
cd ai-efficiency-console-ts

npm install                      # 只装 devDeps（typescript + @types/node），无运行时依赖
npm run gen:mock                 # ① 生成 mock 数据集（生成物，不入库，必须先跑）
npm run selftest                 # ② 接口 + 口径一致性 + HTTP 层自检
npm run serve                    # ③ 启动 -> http://127.0.0.1:8000（同时托管 frontend/dist）

cd frontend && npm install && npm run build   # ④ 构建前端
npm run dev                      # 开发态 -> http://127.0.0.1:5173（已代理 /api 到 8000）
```

需要可复现的数据窗口时：

```bash
AEC_REFERENCE_DAY=2026-09-20 npm run gen:mock
```

> 数据集缺失时后端不会抛 `ENOENT`，而是打印可执行的修复指引后退出。

---

## 3. 架构

```
浏览器  React + TS（5 页面，全局筛选由 ScopeContext 统一）
   │  /api/**（开发态 Vite 代理 → 127.0.0.1:8000）
Node 后端（零运行时依赖，无构建步骤）
   ├── metrics.ts      口径唯一实现：成员日粒度 → 部门/公司 rollup
   ├── routes.ts       22 个接口路由 / 校验 / 错误语义
   ├── datasource.ts   mock JSON ⇄ 企业 OpenAPI（二期只换这一处）
   ├── http/           信封 / 查询解析 / 静态托管 + SPA 回退
   ├── selftest.ts     接口层 + 口径一致性 + HTTP 层自检
   └── pyrandom.ts     Python random.Random 的逐位兼容实现（种子化可复现）
```

**唯一的关键约束**：页面不做聚合，口径只在 `metrics.ts` 有一份实现。

---

## 4. 口径等价性测试（本版最重要的工程手段）

### 问题

把后端换语言时，最容易发生、也最难发现的 bug 是**口径静默漂移**：
代码看起来搬对了、页面也能渲染，但某些数字悄悄变了。这类 bug 不会报错。

### 做法

数据集本身是不是和 Python 版一致**不重要**（都是 mock 数据）。
重要的是：**同一份输入数据集，两个后端必须算出完全相同的数字。**

`scripts/parity-api.mjs` 就是干这个的：让两个后端用 `--dataset` 加载**同一个文件**，
用 30 组相同请求轰过去，深度比对响应 JSON。数值按**精确相等**比较，不做近似。

```bash
# 终端 1：Python 后端
python3 ../ai-efficiency-console/backend/app/server.py \
    --dataset ../ai-efficiency-console/data/mock_dataset.json --port 8001

# 终端 2：TS 后端（同一份数据集）
node backend/src/server.ts \
    --dataset ../ai-efficiency-console/data/mock_dataset.json --port 8002

# 终端 3：比对
npm run parity -- --py http://127.0.0.1:8001 --ts http://127.0.0.1:8002
```

退出码 0 = 全部一致。差异会打印到具体字段（如 `$.data.list[3].credit: python=1234.56 ts=1234.5 (差 -0.06)`）。

### 本版实测结果

**接口级（`npm run parity`，30 组请求，覆盖全部路由）**：

```
比对 30/30 个用例，全部一致 ✓
```

**函数级（逐字段展平成 IEEE754 位模式比对，不做近似）**：

| 模块 | 覆盖 | 结果 |
|---|---|---|
| `metrics.ts` 聚合口径 | 4 组输入组合全部数值叶子 | 8436 个值一致 ✓ |
| `pyrandom.ts` | `getrandbits(k=1..53)`、`randrange` n=2³¹~2⁵³、`randint`、`choice`、`uniform`、`gauss` | 19/19 组一致 ✓ |
| `pyround.ts` | 密集采样 + 边界值 | 8016/8018 位级一致（余 2 处为 `round(-0.5)` → `-0.0`，JSON 中与 `0` 不可区分）|
| `member_data` | 6 组 payload（默认/排序/部门/成员/关键词/空窗口） | 2081 个值一致 ✓ |
| `efficiency_overview` | 6 组（含单日、逆序区间） | 1714 个值一致 ✓ |
| `analytics_*` | 4 个函数 × 6 组时间与筛选组合 | 3380 个值一致 ✓ |
| `observability` | **白名单全部 28 个指标** × 7 种 `groupBy` + 分页/用户过滤 | 7605 个值一致 ✓ |

**自检与前端**：

```
npm run selftest   → 20 个接口用例 + 口径一致性 + 9 个 HTTP 层用例，全部通过
npm test           → 17/17 通过（pyrandom / pyround 回归）
npm run typecheck  → 0 错误（erasableSyntaxOnly 通过即证明语法可擦除）
frontend/ 构建     → 成功（606 modules）
npm run verify     → 5 个页面 + 抽屉 + 6 项交互断言，全部通过
```

---

## 5. 移植中刻意处理的忠实性细节

这些地方如果「想当然地用 JS 写法」，数字就会变：

| 细节 | Python 行为 | 朴素 JS 写法 | 本版做法 |
|---|---|---|---|
| **舍入** | `round()` 是银行家舍入，且在**精确十进制**上正确舍入 | `Math.round(x*100)/100` | `pyround.ts`：BigInt 精确分解 `m×2^e` + half-even，再用 `Number()` 正确舍入 |
| **随机数** | `random.Random(seed)`：MT19937 + 拒绝采样 | `Math.random()`（不可复现） | `pyrandom.ts`：逐位复刻 CPython，种子化可复现 |
| **大范围随机整数** | `randrange(16**8)` 等 `n ≥ 2³²` 走 `bit_length` 拒绝采样 | `32 - Math.clz32(n)` 在 `n ≥ 2³²` 时得 `k = 0`（静默返回 0 且不消耗熵） | `bitLength()` 分级计算；`getrandbits(k>32)` 按字拼接、**只移最后一个字** |
| **单参 `randrange`** | `randrange(stop)` ≡ `randrange(0, stop)` | 只实现双参会让 `b - a` 变 `NaN` → 恒返回 `stop` | `randrange(a, b?)` 两种形式都支持 |
| **空值** | `None` → JSON `null` | `undefined` 会让 `JSON.stringify` **丢掉整个键** | 一律用 `null` |
| **查询串空值** | `parse_qs` 默认丢弃空值 | 保留 `?a=` 为 `''` | `http/query.ts` 对齐丢弃行为 |
| **静态路由分类** | 只有 `/api/**` 与 `/healthz` 走接口 | —— | HTTP 层判定，并有专门的自检用例（见下） |

### `pyround.ts` 的实测结果

用 8018 个值（含 `0.125`/`0.375`/`0.625`/`2.675`/`1.005` 等平局陷阱、次正规数、真实比率）
与 Python 的 `round` 做 **IEEE754 位级**对比：

```
round(x, 2)  0/8018 不一致
round(x, 1)  0/8018 不一致
round(x)  8016/8018  （仅 round(-0.5) 本版返回 -0.0，Python 返回整数 0；
                       JSON 层不可区分，因为 JSON.stringify(-0) === "0"）
```

对照朴素写法错在哪：

| x | Python `round(x,2)` | `Math.round(x*100)/100` |
|---|---|---|
| 0.125 | 0.12 | 0.13 ❌ |
| 0.625 | 0.62 | 0.63 ❌ |
| 2.675 | 2.67 | 2.68 ❌ |

### `pyrandom.ts` 的实测结果

`gen_mock.py` 生成 UUID 用的是 `randrange(16**8)`（`n = 2³²`）与 `randrange(16**12)`（`n = 2⁴⁸`），
这两条路径曾有两个**静默失败**的 bug（值错但不报错，且会让整条随机序列与 CPython 脱轨）：

1. 位长用 `32 - Math.clz32(n)` 实现 —— `n = 2³²` 时 `ToUint32 → 0`，`clz32(0) = 32`，
   于是 `k = 0`，`getrandbits(0)` 返回 0 **且不消耗任何熵**。
2. `getrandbits(k>32)` 把整块拼起来再整体右移；CPython 是**按字拼接、只有最后一个字右移**
   （`words = (k-1)/32 + 1`），两者位序不同、值不同。

修复后与 CPython 逐位对比：

```
getrandbits(k)  k = 1,2,7,8,16,31,32,33,47,49,52,53      全部一致
randrange        n = 2³¹, 2³², 2⁴⁸, 10¹⁵, 2⁵³            全部一致
randint 大区间 / choice(1000) / uniform / gauss           全部一致
合计 19/19 组一致（修复前 5/19 组不一致）
```

**边界**：`getrandbits(k)` 在 `k ≤ 53` 时结果仍是 double 的精确整数（安全整数上限）；
`gen_mock.py` 实际最大用到 49 位，在边界内。`k > 53` 会丢精度，本版不支持。

---

## 6. 已知边界（与 Python 版一致，不是本版的缺陷）

业务口径的限制来自企业 OpenAPI，与后端语言无关，完整证据见
`../docs/DATA-MAPPING.md` §4：

- **部门维度分三类**：消耗可按部门直查；效能必须 rollup；**稳定性拿不到**
  （可观测域 `groupBy` 不支持 `department`），故部门页不展示失败率与时延。
- **`usage/members/query` 用 `userIds`（UUID）**：`userNames` 遇全半角/emoji 会静默不匹配。
- **私有化未配 APM 时可观测域返回 404**，属预期降级 → 展示「不可用」而非 0。
- **「代码提交行数」= `totalNewCodeLines`**（编辑器内新增行），不是 Git commit diff。
- **AI 代码占比 ≠ 提效幅度**：必须与消耗、绝对产出配对展示，禁止包装成绩效结论。
- **数据集不入库**：生成物，窗口终点默认取运行当天。

### 本版特有的差异

- **JSON 浮点文本形式**：Python 输出 `1.0`，JS 输出 `1`。解析后等价
  （前端与等价性测试都解析 JSON），但**原始响应文本不适合逐字节比对**。
- **`round(-0.5)`** 本版返回 `-0.0`，Python 返回整数 `0`。JSON 层不可区分。
- **`meta.generatedAt`**：`gen_mock.ts` 写成**确定性值**（参考日 `T00:00:00+08:00`），
  Python 版写 `datetime.now(TZ)`。这样数据集内容才是 `(seed, 参考日)` 的纯函数，
  「同种子同参考日 ⇒ 逐字节相同」才能成立。该字段在等价性测试中本就列为 volatile。
- **路由层 `ds` 显式传参**：Python 用模块级全局 `DS`，本版把 `DataSource` 作为
  `route(ds, ...)` 的第一个参数。签名上就能看出「这份响应属于哪个数据源」，
  也避免测试之间互相污染。
- **`metricCard` 在 `current` 为 `null` 时退化为按 0 计算**：Python 会在相减处抛
  `TypeError`（不产生响应）。这是不可能出现的数据分支，本版选择不让整个请求崩掉。

---

## 7. 目录结构

```
ai-efficiency-console-ts/
├── backend/
│   ├── tsconfig.json          # erasableSyntaxOnly：钉死只能写可擦除语法
│   └── src/
│       ├── metrics.ts         # ★ 口径唯一实现（唯一允许做聚合的地方）
│       ├── routes.ts          # 路由分派（等价 route()）
│       ├── routes/            # 按域拆分的处理器，便于逐个验证
│       │   ├── shared.ts      #   查询辅助 + 成员明细（两个入口共用同一实现）
│       │   ├── efficiency.ts  #   v1/efficiency：总览 / 额度 / 成员详情
│       │   ├── analytics.ts   #   dashboard/analytics：4 个分析接口
│       │   ├── observability.ts # 可观测域（UTC+8 换算在此）
│       │   └── enterprise.ts  #   企业域 + 旧看板 /metrics
│       ├── datasource.ts      # 数据集装载 + 时间窗口工具 + 额度运行时状态
│       ├── types.ts           # 数据集与领域对象的类型
│       ├── pyround.ts         # Python 兼容 round（银行家舍入 + 精确十进制）
│       ├── pyrandom.ts        # Python random.Random 逐位兼容实现
│       ├── gen_mock.ts        # mock 数据集生成器（与 Python 版逐字节一致）
│       ├── selftest.ts        # 接口 + 口径一致性 + HTTP 层自检
│       ├── server.ts          # 服务入口
│       └── http/
│           ├── envelope.ts    # ok/err/metricCard/seriesPoint
│           ├── query.ts       # parse_qs 等价实现
│           └── server.ts      # 静态托管 + SPA 回退 + 路由分类
├── frontend/                  # React 18 + TS + Vite（复用 Python 版代码）
├── scripts/parity-api.mjs     # ★ 口径等价性测试台
└── data/                      # mock 数据集（生成物，不入库）
```

---

## 8. 变更检查清单

```bash
npm run typecheck        # 类型检查（含 erasableSyntaxOnly 约束）
npm run selftest         # 接口 + 口径一致性 + HTTP 层
cd frontend && npm run typecheck && npm run build
npm run verify -- http://127.0.0.1:8000   # 无头浏览器逐页渲染自检
```

- [ ] 动了聚合口径 → `npm run selftest` 的「部门/成员/公司汇总一致」必须仍通过
- [ ] 动了口径 → **必须跑 `npm run parity` 与 Python 版对数**，0 差异才算完成
- [ ] 动了舍入 → 用 `pyround.ts`，禁止 `Math.round`
- [ ] 新增可选字段 → 用 `null` 不用 `undefined`
- [ ] 新增静态路由 → `/` 与 SPA 深链仍返回 `index.html`；
      `/api/**` 与 `/healthz` 才是接口路径
- [ ] 新增会产出的文件 → `git check-ignore -v <path>` 确认已被忽略
