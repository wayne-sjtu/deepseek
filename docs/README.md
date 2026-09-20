# 文档索引

本目录存放**跨应用的知识**。编排与上手见仓库根的 `AGENTS.md`。

| 文档 | 什么时候看 | 内容 |
|---|---|---|
| `PRINCIPLES.md` | 要改任何数字之前 | 口径六原则：规则、为什么、违约判据 |
| `CONVENTIONS.md` | 写代码之前 | 分层职责、错误码、Python / TS / 文档 / skill 约定 |
| `LAYOUT.md` | 新增文件、不确定放哪层 | 目录布局与职责边界；新增文件的判断顺序 |
| `DATA-MAPPING.md` | 问「这个数能不能拿到」 | 指标 → 接口获取矩阵、部门维度能力、5 个能力缺口 |
| `DESIGN.md` | 了解整体设计 | 目标、指标口径、5 个页面设计、接口对照、实施与验收 |
| `API.md` | 联调、核对接口 | 路径、参数、响应示例、注意事项、自检说明 |

## 阅读顺序建议

**新加入项目**：`AGENTS.md` → `LAYOUT.md` → `DESIGN.md` §1-2 → `PRINCIPLES.md`

**接手改一个指标**：`PRINCIPLES.md` → `.agents/skills/add-metric/` → `DATA-MAPPING.md` §3

**数字被质疑**：`.agents/skills/verify-dashboard-data/` → `PRINCIPLES.md` → `DATA-MAPPING.md` §4

**接真实接口**：`DATA-MAPPING.md` §5 → `API.md` §2 → `PRINCIPLES.md` M5/M6
