import test from "node:test";
import assert from "node:assert/strict";
import {
  isCanonicalTimestamp, splitHalfFreight, sumFinancialAmounts,
} from "../src/finance.js";
import { splitNormalFreight } from "../src/freight.js";

test("distribuição normal 70/25/5 usa maior resto, desempate e preserva todos os centavos", () => {
  const smallestSplits = [
    { courierCents: 0, companyCents: 0, ermesCents: 0 },
    { courierCents: 1, companyCents: 0, ermesCents: 0 },
    { courierCents: 1, companyCents: 1, ermesCents: 0 },
    { courierCents: 2, companyCents: 1, ermesCents: 0 },
    { courierCents: 3, companyCents: 1, ermesCents: 0 },
    { courierCents: 4, companyCents: 1, ermesCents: 0 },
  ];
  for (const [total, expected] of smallestSplits.entries()) {
    const split = splitNormalFreight(total);
    assert.deepEqual(split, expected);
    assert.equal(Object.values(split).reduce((sum, value) => sum + value, 0), total);
  }
  assert.deepEqual(splitNormalFreight(10), {
    courierCents: 7, companyCents: 3, ermesCents: 0,
  });
  assert.deepEqual(splitNormalFreight(11), {
    courierCents: 8, companyCents: 3, ermesCents: 0,
  });
  assert.deepEqual(splitNormalFreight(1001), {
    courierCents: 701,
    companyCents: 250,
    ermesCents: 50,
  });
  assert.deepEqual(splitNormalFreight(1000), {
    courierCents: 700,
    companyCents: 250,
    ermesCents: 50,
  });
  for (const total of [1000, 1001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(Object.values(splitNormalFreight(total))
      .reduce((sum, value) => sum + BigInt(value), 0n), BigInt(total));
  }
});

test("cancelamento pós-coleta divide frete ímpar sem criar ou perder centavos", () => {
  assert.deepEqual(splitHalfFreight(1001), { clientRefundCents: 501, courierCents: 500 });
  assert.deepEqual(splitHalfFreight(1000), { clientRefundCents: 500, courierCents: 500 });
  assert.equal(Object.values(splitHalfFreight(1001)).reduce((total, value) => total + value, 0), 1001);
});

test("rejeita valores financeiros que não sejam centavos inteiros válidos", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => splitHalfFreight(value), /centavos inteiros/);
  }
  assert.throws(() => splitNormalFreight(Number.MAX_SAFE_INTEGER + 1), /inteiros seguros/);
  for (const value of [null, undefined, "", false, Number.NaN,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -1]) {
    assert.throws(() => splitNormalFreight(value), /inteiros seguros/);
  }
});

test("timestamp financeiro aceita somente o formato canônico e datas reais", () => {
  for (const value of [
    "2026-10-19 12:34:56",
    "2024-02-29 00:00:00",
    "2026-12-31 23:59:59",
  ]) assert.equal(isCanonicalTimestamp(value), true, value);

  for (const value of [
    "2026-02-29 10:00:00",
    "2026-02-30 10:00:00",
    "2026-04-31 10:00:00",
    "2026-00-10 10:00:00",
    "2026-13-10 10:00:00",
    "2026-01-00 10:00:00",
    "2026-01-10 24:00:00",
    "2026-01-10 23:60:00",
    "2026-01-10 23:59:60",
    "",
    "2026-01-10T23:59:59Z",
    "não é uma data",
    null,
  ]) assert.equal(isCanonicalTimestamp(value), false, String(value));
});

test("somatório financeiro usa inteiro exato e rejeita overflow", () => {
  assert.equal(sumFinancialAmounts([1, 2, 3]), 6);
  assert.equal(sumFinancialAmounts([Number.MAX_SAFE_INTEGER]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => sumFinancialAmounts([Number.MAX_SAFE_INTEGER, 1]), /limite inteiro seguro/);
});
