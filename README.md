# 烘焙门店日配决策台

本仓库记录该项目已确认的领域对象、事件名称和基础校验方式，便于不同系统交换一致的数据。

## 资料范围

- `contracts/domain.schema.json`：领域事件信封、聚合类型、事件名称，以及按事件类型的字段约束（含事件 → 聚合 → 记录类别的映射）。
- `src/validator.js`：事件信封校验，覆盖 schema 无法表达的跨字段规则（如数据截止时刻不得晚于发生时刻）。
- `data/`：本地联调样例，串起预测、计划调整、库存占用、标签门控、折价、报损与门店复算。
- `tests/`：验证样例符合约定，并锁定关键红线（禁回写、幂等占用、隐私字段等）。

## 记录类别：预测 / 决定 / 实际结果

每条事件必须携带 `record_kind`，三类记录不得混淆：

- `forecast` 预测：必须携带 `knowledge_cutoff`（数据截止时刻），且不得晚于 `occurred_at`——不允许用次日销量等事后数据回写成"当时就知道"。预测更新以新事件发布，`supersedes` 指向被取代的旧版。
- `decision` 决定：必须携带非空 `reason_codes`（店长能看懂当天为什么减产或改走配送）与 `based_on`（引用的依据事件标识，保证计划可追溯）。
- `actual` 实际结果：只记录已发生的事实（产出、销量、报损、成本、实验结果），不回填理由。

记录一经接收，标识、发生时间与版本不得原地改写；更正使用新的后继记录，并以 `supersedes` 指向被更正事件。

## 事件目录

| 事件 | 聚合 | 类别 | 说明 |
| --- | --- | --- | --- |
| `DEMAND_FORECASTED` | `demand_series` | forecast | 门店×SKU×小时需求预测，含数据截止时刻 |
| `SALES_RECORDED` | `demand_series` | actual | 小时级销量实际（聚合粒度，不含顾客标识） |
| `PLAN_RELEASED` | `production_plan` | decision | 日配计划下达（中央工厂 / 前店后厂产能模式、计划量） |
| `PLAN_ADJUSTED` | `production_plan` | decision | 预测更新后的计划调整，仅限未投产数量 |
| `COST_RECORDED` | `production_plan` | actual | 计划对应的实际能耗与人工 |
| `BATCH_RECEIVED` | `inventory_batch` | actual | 原料入库，登记保质期 |
| `BATCH_PRODUCED` | `inventory_batch` | actual | 成品批次产出，登记货架期截止 |
| `BATCH_ALLOCATED` | `inventory_batch` | decision | 批次分配 / 配送到店 |
| `TRANSFER_ORDERED` | `inventory_batch` | decision | 按剩余货架期决定的店间调拨 |
| `MARKDOWN_APPLIED` | `inventory_batch` | decision | 按剩余货架期与清仓规则的折价 |
| `WASTE_RECORDED` | `inventory_batch` | actual | 报损（现制损耗、过期等） |
| `PACKAGING_BLOCKED` | `inventory_batch` | decision | 标签变化后旧包装批次封存停售 |
| `LABEL_REVISION_PUBLISHED` | `recipe_version` | decision | 配方营养 / 健康标签新版本及生效时刻 |
| `INVENTORY_RESERVED` | `reservation` | decision | 线上订单占库存（幂等键 + 承诺时效） |
| `RESERVATION_RELEASED` | `reservation` | decision | 占用释放（取消 / 超时） |
| `STORE_REVIEWED` | `store_decision` | decision | 闭店 / 改造中央配送点 / 保留现烤的复算评估 |
| `PROMO_EXPERIMENT_LAUNCHED` | `promo_experiment` | decision | 促销实验上线（价格、门店范围、假设） |
| `EXPERIMENT_EVALUATED` | `promo_experiment` | actual | 实验评估（价格响应、复购等客群级指标） |

## 关键约定

- **预测更新只调未投产**：`PLAN_ADJUSTED` 的 `adjustment_scope` 必须为 `unreleased`；已烘焙批次只能经 `TRANSFER_ORDERED` / `MARKDOWN_APPLIED` 处理，且必须携带 `remaining_shelf_life_hours` 作为依据。
- **幂等占用**：`INVENTORY_RESERVED` / `RESERVATION_RELEASED` 必须携带 `reservation_key`；同一顾客订单在平台重试时使用同一键，不得重复占库存。承诺时效记入 `promised_at`。
- **标签门控**：`LABEL_REVISION_PUBLISHED` 携带 `effective_from`；健康标签变化后以 `PACKAGING_BLOCKED` 封存旧包装批次（`based_on` 引用标签事件），阻止旧包装继续销售。
- **门店复算**：`STORE_REVIEWED` 必须携带 `scenario`，至少含 `rent_monthly`、`waste_rate`、`service_radius_km`，可附能耗、人工、产能模式等，管理层据此复算闭店、改造中央配送点或保留现烤能力的取舍。
- **归因基础**：促销实验与小时级实际销量按同一 `demand_series` 聚合记录，用于区分价格、低糖需求、配送时效与夜间折扣各自的影响。
- **隐私红线**：事件不得包含可识别单个顾客的字段（`customer_id`、`phone`、`openid` 等，完整清单见 `src/validator.js` 的 `FORBIDDEN_FIELDS`）；需求与销量按门店×SKU×小时聚合，促销实验指标仅到客群级，不读取单个顾客的敏感消费画像。个人、机构及商业敏感信息仅向履行职责所需的调用方开放。

## 本地检查

```bash
node --test
```
