import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATE_TYPES,
  EVENT_SPECS,
  RECORD_KINDS,
  REQUIRED_FIELDS,
  validateEvent,
  validateEventBatch,
} from "../src/validator.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const samplesDir = new URL("../data/samples/", import.meta.url);
const sampleFiles = (await readdir(samplesDir)).filter((name) => name.endsWith(".json")).sort();
const samples = await Promise.all(
  sampleFiles.map(async (name) => JSON.parse(await readFile(new URL(name, samplesDir), "utf8"))),
);

const base = {
  event_id: "evt-test-0001",
  event_type: "PLAN_RELEASED",
  aggregate_type: "production_plan",
  aggregate_id: "pp-test-01",
  occurred_at: "2026-09-22T08:00:00+08:00",
  version: 1,
  record_kind: "decision",
  summary: "测试用基准记录",
};

test("样例覆盖全部事件类型", () => {
  assert.deepEqual(new Set(samples.map((s) => s.event_type)), new Set(Object.keys(EVENT_SPECS)));
});

test("全部样例符合领域约定", () => {
  for (const sample of samples) {
    assert.deepEqual(validateEvent(sample), [], `${sample.event_id} 应通过校验`);
  }
  assert.deepEqual(validateEventBatch(samples), []);
});

test("契约与代码中的枚举和必备字段一致", () => {
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_FIELDS].sort());
  assert.deepEqual([...schema.properties.event_type.enum].sort(), Object.keys(EVENT_SPECS).sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...AGGREGATE_TYPES].sort());
  assert.deepEqual([...schema.properties.record_kind.enum].sort(), [...RECORD_KINDS].sort());
});

test("契约中的条件约束与代码中的必备字段一致", () => {
  const conditionals = new Map();
  for (const rule of schema.allOf ?? []) {
    const type = rule.if?.properties?.event_type?.const;
    if (type) conditionals.set(type, rule.then?.required ?? []);
  }
  for (const [type, spec] of Object.entries(EVENT_SPECS)) {
    assert.deepEqual((conditionals.get(type) ?? []).slice().sort(), [...(spec.requires ?? [])].sort(), type);
    conditionals.delete(type);
  }
  assert.deepEqual([...conditionals.keys()], [], "契约中不应存在代码之外的条件约束");
});

test("缺少 record_kind 或类别与事件类型不符被拒绝", () => {
  const { record_kind, ...missing } = base;
  assert.ok(validateEvent(missing).some((e) => e.includes("record_kind")));

  const wrong = { ...base, event_type: "DEMAND_FORECASTED", aggregate_type: "demand_forecast", data_cutoff_at: "2026-09-22T06:00:00+08:00" };
  assert.ok(validateEvent(wrong).some((e) => e.includes("record_kind 应为 forecast")));
});

test("预测不得用事后数据回写", () => {
  const forecast = {
    ...base,
    event_type: "DEMAND_FORECASTED",
    aggregate_type: "demand_forecast",
    record_kind: "forecast",
    data_cutoff_at: "2026-09-23T06:00:00+08:00",
  };
  assert.ok(validateEvent(forecast).some((e) => e.includes("回写")));

  const { data_cutoff_at, ...missing } = forecast;
  assert.ok(validateEvent(missing).some((e) => e.includes("缺少字段：data_cutoff_at")));
});

test("计划修订只能调整未投产数量", () => {
  const revised = { ...base, event_type: "PLAN_REVISED", revision_scope: "full" };
  assert.ok(validateEvent(revised).some((e) => e.includes("unstarted_only")));
});

test("调拨与折价必须携带剩余货架期", () => {
  for (const event_type of ["TRANSFER_DECIDED", "MARKDOWN_APPLIED"]) {
    const record = { ...base, event_type, aggregate_type: "inventory_batch" };
    assert.ok(validateEvent(record).some((e) => e.includes("缺少字段：remaining_shelf_life_hours")), event_type);
    assert.ok(
      validateEvent({ ...record, remaining_shelf_life_hours: -1 }).some((e) => e.includes("非负数字")),
      event_type,
    );
  }
});

test("订单占库必须幂等，重试不得重复占库存", () => {
  const reservation = {
    ...base,
    event_type: "RESERVATION_CONFIRMED",
    aggregate_type: "customer_order",
    aggregate_id: "co-test-1",
  };
  assert.ok(validateEvent(reservation).some((e) => e.includes("缺少字段：idempotency_key")));

  const first = { ...reservation, event_id: "evt-t-1", idempotency_key: "pltA-order-1" };
  const retry = { ...reservation, event_id: "evt-t-2", idempotency_key: "pltA-order-1" };
  assert.ok(validateEventBatch([first, retry]).some((e) => e.includes("幂等键重复占库")));
  assert.deepEqual(validateEventBatch([first, { ...retry, idempotency_key: "pltA-order-2" }]), []);
});

test("标签换代与旧包装阻断必须指明标签版本", () => {
  const label = { ...base, event_type: "LABEL_SUPERSEDED", aggregate_type: "recipe_version" };
  assert.ok(validateEvent(label).some((e) => e.includes("缺少字段：superseded_label_version")));

  const packaging = { ...base, event_type: "PACKAGING_BLOCKED", aggregate_type: "packaging_batch" };
  assert.ok(validateEvent(packaging).some((e) => e.includes("缺少字段：blocked_label_version")));
});

test("个人敏感消费画像字段被拒绝（含嵌套）", () => {
  const record = { ...base, payload: { buyer: { customer_phone: "13800000000" } } };
  assert.ok(validateEvent(record).some((e) => e.includes("敏感字段：payload.buyer.customer_phone")));
});

test("事件类型与聚合类型必须匹配", () => {
  const record = { ...base, aggregate_type: "inventory_batch" };
  assert.ok(validateEvent(record).some((e) => e.includes("不允许挂在 aggregate_type")));
  assert.ok(validateEvent({ ...base, event_type: "NOPE" }).some((e) => e.includes("未知的 event_type")));
});

test("信封基础字段校验", () => {
  assert.ok(validateEvent({ ...base, version: 0 }).some((e) => e.includes("version 必须是正整数")));
  assert.ok(validateEvent({ ...base, occurred_at: "昨天傍晚" }).some((e) => e.includes("occurred_at")));
  assert.ok(validateEvent({ ...base, summary: "" }).some((e) => e.includes("summary 必须是非空字符串")));
});
