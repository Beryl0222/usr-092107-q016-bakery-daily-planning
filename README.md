# 烘焙门店日配决策台

本仓库记录该项目已确认的领域对象、事件名称和基础校验方式，便于不同系统交换一致的数据。域覆盖：配方营养标签、中央工厂与前店后厂产能、原料保质期、门店小时级需求、线上承诺时效、调拨、清仓规则、报损、能耗人工与促销实验，全部纳入同一套可追溯计划。

## 资料范围

- `contracts/domain.schema.json`：领域事件信封、聚合类型、事件名称与关键条件约束。
- `data/samples/`：每种事件类型一条中文样例，用于本地联调。
- `src/validator.js`：事件信封与领域规则的最小校验代码。
- `tests/`：验证样例、契约与校验代码三者一致。

## 事件约定：预测 / 决定 / 实际

每条事件必须携带 `record_kind`，且与事件类型的归属一致；记录一经接收，标识、发生时间与版本不得原地改写，更正以更高 `version` 的后继记录表达。

| record_kind | 含义 |
| --- | --- |
| `forecast` | 对未来的估计，只允许使用 `data_cutoff_at` 之前已知的数据 |
| `decision` | 计划、占库、调拨、折价等决策 |
| `actual` | 生产、销售、报损、履约等已发生事实 |

### 预测（forecast）

| event_type | aggregate_type | 说明 |
| --- | --- | --- |
| `DEMAND_FORECASTED` | `demand_forecast` | 门店×小时×品项需求预测，必带 `data_cutoff_at` |

### 决定（decision）

| event_type | aggregate_type | 说明 |
| --- | --- | --- |
| `PLAN_RELEASED` | `production_plan` | 日配计划下达（中央工厂 / 前店后厂产能分配） |
| `PLAN_REVISED` | `production_plan` | 计划修订，`revision_scope` 只能为 `unstarted_only` |
| `CAPACITY_UPDATED` | `capacity_slot` | 产能时段登记或调整 |
| `BATCH_ALLOCATED` | `inventory_batch` | 已烘焙批次分配到门店与渠道 |
| `TRANSFER_DECIDED` | `inventory_batch` | 调拨决定，必带 `remaining_shelf_life_hours` |
| `MARKDOWN_APPLIED` | `inventory_batch` | 清仓折价，必带 `remaining_shelf_life_hours` |
| `CLEARANCE_RULE_PUBLISHED` | `clearance_rule` | 清仓规则发布 |
| `RESERVATION_CONFIRMED` | `customer_order` | 线上订单占库，必带 `idempotency_key` |
| `LABEL_SUPERSEDED` | `recipe_version` | 营养 / 健康标签换代，必带 `superseded_label_version` |
| `PACKAGING_BLOCKED` | `packaging_batch` | 旧包装阻断销售，必带 `blocked_label_version` |
| `PROMOTION_LAUNCHED` | `promotion_experiment` | 促销实验上线 |
| `STORE_REVIEWED` | `store_decision` | 闭店 / 改造 / 保留现烤评估结论 |

### 实际（actual）

| event_type | aggregate_type | 说明 |
| --- | --- | --- |
| `BATCH_PRODUCED` | `inventory_batch` | 实际产出，记录能耗与人工 |
| `INGREDIENT_RECEIVED` | `ingredient_lot` | 原料入库，记录保质期 |
| `SALE_RECORDED` | `store_day` | 门店小时级销售实绩（聚合口径） |
| `WASTE_RECORDED` | `inventory_batch` / `ingredient_lot` | 报损 |
| `TRANSFER_COMPLETED` | `transfer_order` | 调拨完成 |
| `ORDER_FULFILLED` | `customer_order` | 履约结果与承诺时效达成情况 |
| `EXPERIMENT_MEASURED` | `promotion_experiment` | 实验效果读数（价格、复购，聚合口径） |
| `STORE_DAY_CLOSED` | `store_day` | 门店日结（能耗、人工、报损、租金） |

## 关键规则

1. **记录不可改写**：标识、发生时间与版本不得原地修改，更正以更高 `version` 的新记录表达。
2. **预测不得回写**：`DEMAND_FORECASTED` 必带 `data_cutoff_at` 且不晚于 `occurred_at`，禁止用次日销量回写成"当时就知道"。
3. **预测更新只调未投产**：`PLAN_REVISED` 的 `revision_scope` 只能为 `unstarted_only`；已烘焙部分转入调拨或折价流程。
4. **已烘焙按剩余货架期路由**：`TRANSFER_DECIDED` 与 `MARKDOWN_APPLIED` 必带 `remaining_shelf_life_hours`。
5. **占库幂等**：`RESERVATION_CONFIRMED` 必带 `idempotency_key`，平台重试使用同一键；`validateEventBatch` 拒绝同键重复记录。
6. **标签换代阻断旧包装**：`LABEL_SUPERSEDED` 记录被停用的标签版本，`PACKAGING_BLOCKED` 据此阻止旧包装继续销售。
7. **隐私边界**：事件只承载门店、批次、时段等聚合口径；校验器拒绝顾客标识、联系方式、住址等敏感字段，管理层评估闭店与服务半径时不读取单个顾客画像。

个人、机构及商业敏感信息仅向履行职责所需的调用方开放。

## 本地检查

```bash
node --test
```
