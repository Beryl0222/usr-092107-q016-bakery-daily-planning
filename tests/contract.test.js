import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { EVENT_CONVENTIONS, validateEvent } from "../src/validator.js";

const dataDir = new URL("../data/", import.meta.url);

async function readSamples() {
  const names = (await readdir(dataDir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(new URL(name, dataDir), "utf8"))]));
}

const forecastBase = {
  event_id: "evt-test-001",
  event_type: "DEMAND_FORECASTED",
  aggregate_type: "demand_series",
  aggregate_id: "store-117:sku-sweet-milk-bread",
  occurred_at: "2026-09-22T04:30:00+08:00",
  record_kind: "forecast",
  version: 1,
  knowledge_cutoff: "2026-09-22T04:00:00+08:00",
  summary: "测试用预测事件",
};

function decisionBase() {
  return {
    event_id: "evt-test-101",
    event_type: "PLAN_ADJUSTED",
    aggregate_type: "production_plan",
    aggregate_id: "plan-store-117-20260922",
    occurred_at: "2026-09-22T05:10:00+08:00",
    record_kind: "decision",
    version: 2,
    adjustment_scope: "unreleased",
    reason_codes: ["sweet_soft_category_slowdown"],
    based_on: ["evt-test-001"],
    summary: "测试用计划调整",
  };
}

test("data/ 下全部样例符合领域约定", async () => {
  const samples = await readSamples();
  assert.ok(samples.length >= 8, "样例数量不足");
  for (const [name, sample] of samples) {
    assert.deepEqual(validateEvent(sample), [], `${name} 应通过校验`);
  }
});

test("事件目录与 JSON Schema 保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), Object.keys(EVENT_CONVENTIONS).sort());
  const aggregates = [...new Set(Object.values(EVENT_CONVENTIONS).map((c) => c.aggregate_type))].sort();
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), aggregates);
});

test("schema 中的事件映射与校验代码一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const blocks = schema.allOf.filter((block) => block.if?.properties?.event_type?.const);
  const mapping = Object.fromEntries(blocks.map((block) => [block.if.properties.event_type.const, block.then.properties]));
  for (const [type, convention] of Object.entries(EVENT_CONVENTIONS)) {
    assert.equal(mapping[type]?.aggregate_type?.const, convention.aggregate_type, `${type} 聚合映射不一致`);
    assert.equal(mapping[type]?.record_kind?.const, convention.record_kind, `${type} 记录类别映射不一致`);
  }
});

test("预测必须携带数据截止时刻，且不得用事后数据回写", () => {
  const missing = { ...forecastBase };
  delete missing.knowledge_cutoff;
  assert.ok(validateEvent(missing).some((e) => e.includes("knowledge_cutoff")));
  const backfilled = { ...forecastBase, knowledge_cutoff: "2026-09-23T04:00:00+08:00" };
  assert.ok(validateEvent(backfilled).some((e) => e.includes("回写")));
});

test("决定必须给出理由与依据", () => {
  const errors = validateEvent({ ...decisionBase(), reason_codes: [], based_on: [] });
  assert.ok(errors.some((e) => e.includes("reason_codes")));
  assert.ok(errors.some((e) => e.includes("based_on")));
});

test("预测更新只能调整未投产数量", () => {
  assert.ok(validateEvent({ ...decisionBase(), adjustment_scope: "released" }).some((e) => e.includes("unreleased")));
  const missing = decisionBase();
  delete missing.adjustment_scope;
  assert.ok(validateEvent(missing).some((e) => e.includes("unreleased")));
});

test("线上占用必须携带幂等键", () => {
  const reservation = {
    event_id: "evt-test-201",
    event_type: "INVENTORY_RESERVED",
    aggregate_type: "reservation",
    aggregate_id: "rsv-order-1",
    occurred_at: "2026-09-22T18:42:00+08:00",
    record_kind: "decision",
    version: 1,
    reason_codes: ["online_order_half_hour_promise"],
    based_on: ["evt-test-001"],
    summary: "测试用库存占用",
  };
  assert.ok(validateEvent(reservation).some((e) => e.includes("reservation_key")));
  assert.deepEqual(validateEvent({ ...reservation, reservation_key: "order-1:sku-1" }), []);
});

test("调拨与折价必须依据剩余货架期", () => {
  const markdown = {
    event_id: "evt-test-301",
    event_type: "MARKDOWN_APPLIED",
    aggregate_type: "inventory_batch",
    aggregate_id: "batch-1",
    occurred_at: "2026-09-22T19:00:00+08:00",
    record_kind: "decision",
    version: 1,
    reason_codes: ["shelf_life_short"],
    based_on: ["evt-test-001"],
    summary: "测试用折价",
  };
  assert.ok(validateEvent(markdown).some((e) => e.includes("remaining_shelf_life_hours")));
  assert.deepEqual(validateEvent({ ...markdown, remaining_shelf_life_hours: 4 }), []);
});

test("事件不得包含可识别单个顾客的字段", () => {
  assert.ok(validateEvent({ ...forecastBase, customer_id: "c-1" }).some((e) => e.includes("customer_id")));
  assert.ok(validateEvent({ ...forecastBase, openid: "o-1" }).some((e) => e.includes("openid")));
});

test("事件类型与聚合、记录类别必须匹配约定", () => {
  assert.ok(validateEvent({ ...forecastBase, aggregate_type: "recipe_version" }).some((e) => e.includes("aggregate_type")));
  assert.ok(validateEvent({ ...forecastBase, record_kind: "actual" }).some((e) => e.includes("record_kind")));
  assert.ok(validateEvent({ ...forecastBase, event_type: "NOT_A_REAL_EVENT" }).some((e) => e.includes("未知事件类型")));
});

test("更正必须指向其他事件", () => {
  assert.ok(validateEvent({ ...forecastBase, supersedes: forecastBase.event_id }).some((e) => e.includes("supersedes")));
  const correction = { ...forecastBase, event_id: "evt-test-002", version: 2, supersedes: "evt-test-001" };
  assert.deepEqual(validateEvent(correction), []);
});
