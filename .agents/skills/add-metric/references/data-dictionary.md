# 数据字典与字段流转

新增或排查指标时对照本表，避免「字段名到处都有但没人知道它在哪一层产生」。

## 1. 三层流转

```
gen_mock.py  series[]          metrics.py SUM_FIELDS / _finalize()      server.py 响应字段
（日粒度原始字段，单字缩写）  →  （聚合 + 比率派生 + 文档同名别名）      →  （对外 JSON，__ 前缀=扩展）
```

前端只认第三层（`lib/types.ts` 与之一一对应）。

## 2. 原始字段（`series[]` 中的缩写键）

| 键 | 含义 | 文档对应字段 |
|---|---|---|
| `d` / `u` | 日期 / 成员 ID | — |
| `cg` / `ca` | 补全生成次数 / 采纳次数 | completionGenerateCount / completionAcceptCount |
| `cgl` / `cal` | 补全生成行 / 采纳行 | completionGenerateLines / completionAcceptLines |
| `cgc` / `cac` | 补全生成字符 / 采纳字符 | completionGenerateChars / completionAcceptChars |
| `dc` | 对话次数 | dialogCount |
| `dk` / `dcr` / `da` / `dkb` / `dct` / `dcm` / `dac` / `dcy` | Ask / Craft / Agent / 知识库 / 上下文 / 命令 / 动作 / 自定义 | 对话能力拆分 |
| `ail` / `tnl` | AI 生成代码行 / 新增代码总行 | aiGenerateCodeLines / totalNewCodeLines |
| `aic` / `tnc` | AI 生成字符 / 新增代码字符 | aiGenerateCodeChars / totalNewCodeChars |
| `cr` / `crc` | Credits 消耗 / 折算成本 | totalUsed |
| `it` / `ot` / `cri` | 输入 token / 输出 token / 缓存命中输入 token | input_token / output_token / cache_read_input_token |
| `sc` / `rq` | 会话数 / 请求数 | session_count / genai_request_count |
| `err` / `tc` / `te` | 请求失败数 / 工具调用数 / 工具失败数 | model_error_count / tool_call_count |
| `ttft` `p50` `p90` `p95` `p99` | 首 token 时延 | ttft_avg / ttft_p50… |
| `dur` `dp50` `dp95` | 模型调用耗时 | genai_operation_duration_avg / model_invocation_duration_* |
| `sdur` / `srd` | 会话时长 / 平均轮次 | avg_session_duration / avg_session_rounds |
| `cl` / `pv` / `md` / `lg` | 客户端 / 插件版本 / 模型 / 编程语言 | 分组维度（`ROW_DIM_FIELD`） |

## 3. 聚合层派生字段（`_finalize()` 产出）

| 字段 | 公式 | 分母为 0 时 |
|---|---|---|
| `completionAcceptRateByCount` | ca / cg ×100 | `null` |
| `completionAcceptRateByLines` | cal / cgl ×100 | `null` |
| `completionAcceptRateByChars` | cac / cgc ×100 | `null` |
| `codeGenerateRateByLines` | ail / tnl ×100 | `null` |
| `codeGenerateRateByChars` | aic / tnc ×100 | `null` |
| `requestErrorRate` | err / rq ×100 | `null` |
| `toolErrorRate` | te / tc ×100 | `null` |
| `tokenUsage` | it + ot | 0 |
| `credit` | round(cr, 2) | 0 |
| `dau` | 活跃成员数 / 天数 | 0 |
| `avgCreditsPerActiveUser` | cr / 活跃成员数 | 0 |
| `creditsPerKline` | cr / (tnl/1000) | `null` |
| `quotaUsageRate` | cr / cycleLimit ×100 | `null`（不限量） |

## 4. 可观测白名单指标映射（`METRIC_WHITELIST`）

供 `/openapi/observability/metric-*` 使用。键为文档里的指标名，值为本仓库原始字段：

```
genai_request_count→rq   model_request_count→rq   model_error_count→err
tool_call_count→tc       tool_error_count→te      session_count→sc
token_usage→(it+ot)      input_token→it           output_token→ot
cache_read_input_token→cri   credit→cr            credit_cost→crc
ttft_avg/p50/p90/p95/p99→ttft/p50/p90/p95/p99
genai_operation_duration_avg→dur   model_invocation_duration_p50/p95→dp50/dp95
dau→(派生)  user_count→(派生)  tool_error_rate→(派生)
completion_accept_rate_by_lines / code_generate_rate_by_lines / ai_generate_code_lines
/ total_new_code_lines / dialog_count→对应聚合字段
```

## 5. 分组维度

`GROUP_DIMENSIONS` 声明可用维度；`ROW_DIM_FIELD` 声明哪些维度来自记录行字段
（`model` / `client` / `plugin` / `language`），其余（`department` / `user`）由
`daily_points()` 内部特殊处理（查 `dept_of` 索引或成员名）。

> 注意：真实企业接口的 `groupBy` **不支持 department**，本仓库的部门分组是后端自行 rollup 的能力。
