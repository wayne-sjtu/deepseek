# 工程约定（Conventions）

> 面向对象：在本仓库写代码的人（含代理）。
> 编排与流程见 `../AGENTS.md`，口径规则见 `PRINCIPLES.md`。

---

## 1. 通用

- 注释与文案用中文，解释**为什么**而不是「做了什么」。代码已经说明了 what，注释要补 why。
- **不引入新依赖**：后端只用 Python 标准库；前端新增依赖需先说明理由与体积影响
  （当前 echarts 已占 343KB gzip，是全仓最大的一块）。
- **不硬编码颜色**：统一从 `frontend/src/lib/theme.ts` 取（`COLORS` / `SERIES_PALETTE`）。
- 改动会产出文件/目录时，在根 `.gitignore` 里确认被忽略 —— 用 `git check-ignore -v <path>`
  验证，不靠肉眼判断。

## 2. Python（`backend/app/`）

- 类型标注 + `from __future__ import annotations`；纯函数优先。
- 分层职责不可越界：
  - `gen_mock.py` 只产数据，不含业务聚合；
  - `metrics.py` 只做口径，不含 HTTP / JSON 包装；
  - `server.py` 只管路由、校验、错误语义、静态托管，不写指标公式。
- 路由统一返回 `(status, payload)`，经 `ok()` / `err(code, msg)` 包装为
  `{code, msg, requestId, data}`，`code = 0` 表示成功。
- 错误码：

  | code | HTTP | 语义 |
  |---|---|---|
  | `0` | 200 | 成功 |
  | `40001` | 400 | 参数非法 |
  | `40301` | 403 | 跨企业 / 无权限 |
  | `40400` | 404 | 未实现 |
  | `40500` | 405 | 方法不允许 |
  | `50000` | 500 | 服务端异常 |

- 新增/修改接口后，**必须**同步更新 `server.py` 顶部的接口清单注释与 `SELFTEST_CASES`。
- 数据集是生成物：缺失时给可执行指引并退出，不要静默返回空数据。

## 3. TypeScript / React（`frontend/`）

- `strict` + `noUnusedLocals` + `noUnusedParameters` 全开；提交前 `npm run typecheck` 必须 0 error。
- **页面只通过 `lib/api.ts` 取数**，组件里禁止 `fetch`。数据来源切换（mock / live）只改环境变量。
- 筛选条件（时间范围、部门）**只能**来自 `useScope()`；页面自建一份会导致切页后口径漂移。
- 类型集中在 `lib/types.ts`：与 `document.yaml` 同名的字段表示直接来自企业接口，
  `__` 前缀表示本方案扩展字段。
- 图表：option 用 `useMemo` 组装，容器用 `components/Chart.tsx`（已处理自适应与 `dispose`）；
  写法见 `.agents/skills/develop-frontend-page/references/chart-recipes.md`。
- 表格：数值列右对齐 + `font-mono tabular-nums`，列头 `tooltip` 写口径。
- 数字与时间格式化统一走 `lib/format.ts`，**不要在 JSX 里写 `toFixed`**。
  比率变化用 `deltaUnit: 'point'`（百分点 `pp`），消耗类指标设 `higherIsBetter: false`。
- 需要按部门下钻时用 `useSearchParams()` 传 `?dept=`，保证链接可分享、可回退。
- **弹层（下拉 / 菜单 / 气泡卡）一律用 `lib/useDismissable.ts`**，不要只用
  `useState(false)` 手写：必须支持「点外部区域收起」与「Esc 收起」。
  多选类弹层在勾选后保持展开，并提供「完成」按钮作为明确出口。
  挂 `ref` 时注意它要包住**触发器与面板两者**，否则点触发器会先收起再打开。

## 4. 文档

- 每个数字都要能在 `MetricsPage.tsx` 的指标字典里找到定义与来源；
  改了指标定义必须同步改口径页，否则口径页失去意义。
- 文档职责单一：原则 → `PRINCIPLES.md`；接口能力 → `DATA-MAPPING.md`；
  设计取舍 → `DESIGN.md`；接口契约 → `API.md`。新增内容先判断属于哪一份，避免多份漂移。
- 文档里引用路径时写明相对哪一层（仓库根 or 应用内），因为 `docs/` 在根、代码在应用内。

## 5. Skill

- 项目级 skill 位于 `.agents/skills/<name>/SKILL.md`，写入即生效。
- 只写本项目特有的内容；`AGENTS.md` 与 `docs/` 已有的不复述，用相对路径指过去。
- 新增 skill 后更新 `AGENTS.md` §4 的表与 `SKILLS.md` 索引；
  格式与检查清单见 `.agents/skills/write-project-skill/SKILL.md`。
