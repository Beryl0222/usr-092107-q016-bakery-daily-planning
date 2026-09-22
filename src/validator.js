// 事件约定：每条记录必须声明 record_kind（forecast 预测 / decision 决定 / actual 实际），
// 并与 event_type 的归属一致。记录一经接收，标识、发生时间与版本不得原地改写，
// 更正以更高 version 的后继记录表达。

export const RECORD_KINDS = ["forecast", "decision", "actual"];

const KIND_LABEL = { forecast: "预测", decision: "决定", actual: "实际" };

export const REQUIRED_FIELDS = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "record_kind",
  "summary",
];

// 事件谱系：kind 为记录类别，aggregates 为允许挂载的聚合，requires 为该类事件的必备字段。
export const EVENT_SPECS = {
  // —— 预测 ——
  DEMAND_FORECASTED: { kind: "forecast", aggregates: ["demand_forecast"], requires: ["data_cutoff_at"] },
  // —— 决定 ——
  PLAN_RELEASED: { kind: "decision", aggregates: ["production_plan"] },
  PLAN_REVISED: { kind: "decision", aggregates: ["production_plan"], requires: ["revision_scope"] },
  CAPACITY_UPDATED: { kind: "decision", aggregates: ["capacity_slot"] },
  BATCH_ALLOCATED: { kind: "decision", aggregates: ["inventory_batch"] },
  TRANSFER_DECIDED: { kind: "decision", aggregates: ["inventory_batch"], requires: ["remaining_shelf_life_hours"] },
  MARKDOWN_APPLIED: { kind: "decision", aggregates: ["inventory_batch"], requires: ["remaining_shelf_life_hours"] },
  CLEARANCE_RULE_PUBLISHED: { kind: "decision", aggregates: ["clearance_rule"] },
  RESERVATION_CONFIRMED: { kind: "decision", aggregates: ["customer_order"], requires: ["idempotency_key"] },
  LABEL_SUPERSEDED: { kind: "decision", aggregates: ["recipe_version"], requires: ["superseded_label_version"] },
  PACKAGING_BLOCKED: { kind: "decision", aggregates: ["packaging_batch"], requires: ["blocked_label_version"] },
  PROMOTION_LAUNCHED: { kind: "decision", aggregates: ["promotion_experiment"] },
  STORE_REVIEWED: { kind: "decision", aggregates: ["store_decision"] },
  // —— 实际 ——
  BATCH_PRODUCED: { kind: "actual", aggregates: ["inventory_batch"] },
  INGREDIENT_RECEIVED: { kind: "actual", aggregates: ["ingredient_lot"] },
  SALE_RECORDED: { kind: "actual", aggregates: ["store_day"] },
  WASTE_RECORDED: { kind: "actual", aggregates: ["inventory_batch", "ingredient_lot"] },
  TRANSFER_COMPLETED: { kind: "actual", aggregates: ["transfer_order"] },
  ORDER_FULFILLED: { kind: "actual", aggregates: ["customer_order"] },
  EXPERIMENT_MEASURED: { kind: "actual", aggregates: ["promotion_experiment"] },
  STORE_DAY_CLOSED: { kind: "actual", aggregates: ["store_day"] },
};

export const AGGREGATE_TYPES = [...new Set(Object.values(EVENT_SPECS).flatMap((spec) => spec.aggregates))].sort();

// 个人敏感消费画像不得进入领域事件（键名不区分大小写，递归检查嵌套结构）。
const SENSITIVE_KEYS = new Set([
  "customer_id",
  "customer_name",
  "customer_phone",
  "phone",
  "mobile",
  "id_card",
  "id_number",
  "address",
  "delivery_address",
  "geolocation",
  "gps",
  "profile",
  "member_profile",
  "gender",
  "birth_date",
  "birthday",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function findSensitiveKeys(value, path = "") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findSensitiveKeys(item, `${path}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEYS.has(key.toLowerCase())) hits.push(here);
      hits.push(...findSensitiveKeys(inner, here));
    }
  }
  return hits;
}

export function validateEvent(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["记录必须是对象"];
  const errors = [];

  for (const name of REQUIRED_FIELDS) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  for (const name of ["event_id", "aggregate_id", "summary"]) {
    if (name in record && !isNonEmptyString(record[name])) errors.push(`${name} 必须是非空字符串`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && !isDateTime(record.occurred_at)) {
    errors.push("occurred_at 必须是有效的日期时间字符串");
  }
  if ("record_kind" in record && !RECORD_KINDS.includes(record.record_kind)) {
    errors.push(`record_kind 必须是 ${RECORD_KINDS.join(" / ")} 之一`);
  }

  const spec = EVENT_SPECS[record.event_type];
  if (!spec) {
    if ("event_type" in record) errors.push(`未知的 event_type：${record.event_type}`);
  } else {
    if (!spec.aggregates.includes(record.aggregate_type)) {
      errors.push(`${record.event_type} 不允许挂在 aggregate_type：${record.aggregate_type}`);
    }
    if (RECORD_KINDS.includes(record.record_kind) && record.record_kind !== spec.kind) {
      errors.push(`record_kind 应为 ${spec.kind}（${KIND_LABEL[spec.kind]}），收到 ${record.record_kind}`);
    }
    for (const field of spec.requires ?? []) {
      if (!(field in record)) errors.push(`缺少字段：${field}`);
    }
  }

  // 预测不得使用事后数据：数据截止时间必须不晚于事件发生时间。
  if (record.event_type === "DEMAND_FORECASTED") {
    if ("data_cutoff_at" in record && !isDateTime(record.data_cutoff_at)) {
      errors.push("data_cutoff_at 必须是有效的日期时间字符串");
    } else if (isDateTime(record.data_cutoff_at) && isDateTime(record.occurred_at)
      && Date.parse(record.data_cutoff_at) > Date.parse(record.occurred_at)) {
      errors.push("data_cutoff_at 不能晚于 occurred_at：预测不得用事后数据回写");
    }
  }

  // 预测更新只能调整未投产数量。
  if (record.event_type === "PLAN_REVISED" && "revision_scope" in record && record.revision_scope !== "unstarted_only") {
    errors.push("revision_scope 只能是 unstarted_only：预测更新只能调整未投产数量");
  }

  // 已烘焙商品按剩余货架期决定调拨或折价。
  if (["TRANSFER_DECIDED", "MARKDOWN_APPLIED"].includes(record.event_type) && "remaining_shelf_life_hours" in record) {
    const hours = record.remaining_shelf_life_hours;
    if (typeof hours !== "number" || Number.isNaN(hours) || hours < 0) {
      errors.push("remaining_shelf_life_hours 必须是非负数字：已烘焙商品按剩余货架期路由");
    }
  }

  // 线上订单占库必须携带幂等键，平台重试凭同一键去重。
  if (record.event_type === "RESERVATION_CONFIRMED" && "idempotency_key" in record && !isNonEmptyString(record.idempotency_key)) {
    errors.push("idempotency_key 必须是非空字符串：平台重试凭同一键去重");
  }

  // 健康标签换代必须指明被停用的旧标签，旧包装据此阻断销售。
  if (record.event_type === "LABEL_SUPERSEDED" && "superseded_label_version" in record && !isNonEmptyString(record.superseded_label_version)) {
    errors.push("superseded_label_version 必须是非空字符串");
  }
  if (record.event_type === "PACKAGING_BLOCKED" && "blocked_label_version" in record && !isNonEmptyString(record.blocked_label_version)) {
    errors.push("blocked_label_version 必须是非空字符串");
  }

  for (const hit of findSensitiveKeys(record)) {
    errors.push(`包含敏感字段：${hit}（个人消费画像不得进入领域事件）`);
  }

  return errors;
}

// 批量校验：在单条规则之上，检查同一幂等键的占库记录不得重复出现（平台重试不重复占库存）。
export function validateEventBatch(records) {
  const errors = [];
  const reservationKeys = new Map();
  records.forEach((record, index) => {
    for (const error of validateEvent(record)) errors.push(`第 ${index + 1} 条：${error}`);
    if (record?.event_type === "RESERVATION_CONFIRMED" && isNonEmptyString(record.idempotency_key)) {
      if (reservationKeys.has(record.idempotency_key)) {
        errors.push(`幂等键重复占库：${record.idempotency_key}（第 ${reservationKeys.get(record.idempotency_key) + 1} 条与第 ${index + 1} 条）`);
      } else {
        reservationKeys.set(record.idempotency_key, index);
      }
    }
  });
  return errors;
}
