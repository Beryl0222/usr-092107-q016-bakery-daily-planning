// 事件约定：事件类型 → 所属聚合与记录类别（forecast 预测 / decision 决定 / actual 实际结果）
export const EVENT_CONVENTIONS = {
  DEMAND_FORECASTED: { aggregate_type: "demand_series", record_kind: "forecast" },
  SALES_RECORDED: { aggregate_type: "demand_series", record_kind: "actual" },
  PLAN_RELEASED: { aggregate_type: "production_plan", record_kind: "decision" },
  PLAN_ADJUSTED: { aggregate_type: "production_plan", record_kind: "decision" },
  COST_RECORDED: { aggregate_type: "production_plan", record_kind: "actual" },
  BATCH_RECEIVED: { aggregate_type: "inventory_batch", record_kind: "actual" },
  BATCH_PRODUCED: { aggregate_type: "inventory_batch", record_kind: "actual" },
  BATCH_ALLOCATED: { aggregate_type: "inventory_batch", record_kind: "decision" },
  TRANSFER_ORDERED: { aggregate_type: "inventory_batch", record_kind: "decision" },
  MARKDOWN_APPLIED: { aggregate_type: "inventory_batch", record_kind: "decision" },
  WASTE_RECORDED: { aggregate_type: "inventory_batch", record_kind: "actual" },
  PACKAGING_BLOCKED: { aggregate_type: "inventory_batch", record_kind: "decision" },
  LABEL_REVISION_PUBLISHED: { aggregate_type: "recipe_version", record_kind: "decision" },
  INVENTORY_RESERVED: { aggregate_type: "reservation", record_kind: "decision" },
  RESERVATION_RELEASED: { aggregate_type: "reservation", record_kind: "decision" },
  STORE_REVIEWED: { aggregate_type: "store_decision", record_kind: "decision" },
  PROMO_EXPERIMENT_LAUNCHED: { aggregate_type: "promo_experiment", record_kind: "decision" },
  EXPERIMENT_EVALUATED: { aggregate_type: "promo_experiment", record_kind: "actual" },
};

export const RECORD_KINDS = ["forecast", "decision", "actual"];

// 可识别单个顾客的字段一律不进入事件流；需求与销量按门店×SKU×小时聚合，实验指标仅到客群级
export const FORBIDDEN_FIELDS = [
  "customer_id", "customer_name", "customer_phone", "member_id", "user_id",
  "phone", "mobile", "id_card", "id_number", "openid", "open_id", "unionid", "union_id",
  "device_id", "ip_address", "address", "gps", "location",
];

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "record_kind", "version", "summary"];

const isTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isNonEmptyStringArray = (value) => Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["记录必须是对象"];
  const errors = [];

  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("event_id" in record && !isNonEmptyString(record.event_id)) errors.push("event_id 必须是非空字符串");
  if ("aggregate_id" in record && !isNonEmptyString(record.aggregate_id)) errors.push("aggregate_id 必须是非空字符串");
  if ("summary" in record && !isNonEmptyString(record.summary)) errors.push("summary 必须是非空字符串");
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("occurred_at" in record && !isTime(record.occurred_at)) errors.push("occurred_at 必须是合法时间");
  if ("record_kind" in record && !RECORD_KINDS.includes(record.record_kind)) errors.push(`record_kind 必须是：${RECORD_KINDS.join(" / ")}`);

  const convention = EVENT_CONVENTIONS[record.event_type];
  if ("event_type" in record && !convention) errors.push(`未知事件类型：${record.event_type}`);
  if (convention) {
    if (record.aggregate_type !== convention.aggregate_type) {
      errors.push(`${record.event_type} 的 aggregate_type 必须是 ${convention.aggregate_type}`);
    }
    if ("record_kind" in record && record.record_kind !== convention.record_kind) {
      errors.push(`${record.event_type} 的 record_kind 必须是 ${convention.record_kind}`);
    }
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (field in record) errors.push(`不得包含可识别单个顾客的字段：${field}`);
  }

  const kind = convention?.record_kind ?? record.record_kind;
  if (kind === "forecast") {
    if (!("knowledge_cutoff" in record)) {
      errors.push("预测事件必须携带 knowledge_cutoff（数据截止时刻）");
    } else if (!isTime(record.knowledge_cutoff)) {
      errors.push("knowledge_cutoff 必须是合法时间");
    } else if (isTime(record.occurred_at) && Date.parse(record.knowledge_cutoff) > Date.parse(record.occurred_at)) {
      errors.push("knowledge_cutoff 不得晚于 occurred_at：不得用事后数据回写预测");
    }
  }
  if (kind === "decision") {
    if (!isNonEmptyStringArray(record.reason_codes)) errors.push("决定事件必须携带非空 reason_codes（说明当天为什么这样决定）");
    if (!isNonEmptyStringArray(record.based_on)) errors.push("决定事件必须携带非空 based_on（引用依据事件，保证计划可追溯）");
  }

  if (record.event_type === "INVENTORY_RESERVED" || record.event_type === "RESERVATION_RELEASED") {
    if (!isNonEmptyString(record.reservation_key)) {
      errors.push(`${record.event_type} 必须携带非空 reservation_key：平台重试使用同一键，不得重复占库存`);
    }
  }
  if (record.event_type === "TRANSFER_ORDERED" || record.event_type === "MARKDOWN_APPLIED") {
    if (typeof record.remaining_shelf_life_hours !== "number" || record.remaining_shelf_life_hours < 0) {
      errors.push(`${record.event_type} 必须携带非负 remaining_shelf_life_hours：已烘焙商品按剩余货架期决定调拨或折价`);
    }
  }
  if (record.event_type === "PLAN_ADJUSTED" && record.adjustment_scope !== "unreleased") {
    errors.push("PLAN_ADJUSTED 的 adjustment_scope 必须是 unreleased：预测更新只能调整未投产数量");
  }
  if (record.event_type === "LABEL_REVISION_PUBLISHED" && !isTime(record.effective_from)) {
    errors.push("LABEL_REVISION_PUBLISHED 必须携带合法 effective_from（健康标签生效时刻）");
  }
  if (record.event_type === "STORE_REVIEWED") {
    const scenario = record.scenario;
    if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
      errors.push("STORE_REVIEWED 必须携带 scenario（租金、损耗、服务半径等复算参数）");
    } else {
      for (const key of ["rent_monthly", "waste_rate", "service_radius_km"]) {
        if (typeof scenario[key] !== "number") errors.push(`STORE_REVIEWED 的 scenario 缺少数值参数：${key}`);
      }
    }
  }
  if ("supersedes" in record) {
    if (!isNonEmptyString(record.supersedes)) errors.push("supersedes 必须是非空事件标识");
    else if (record.supersedes === record.event_id) errors.push("supersedes 不得指向自身");
  }

  return errors;
}
