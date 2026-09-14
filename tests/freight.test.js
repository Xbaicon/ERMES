import test from "node:test";
import assert from "node:assert/strict";
import { calculateFreight, splitNormalFreight, weightFeeCents } from "../src/freight.js";

test("aplica todas as fronteiras das faixas de peso", () => {
  assert.equal(weightFeeCents(0.999), 300);
  assert.equal(weightFeeCents(1), 500);
  assert.equal(weightFeeCents(2.999), 500);
  assert.equal(weightFeeCents(3), 900);
  assert.equal(weightFeeCents(7.999), 900);
  assert.equal(weightFeeCents(8), 1200);
  assert.equal(weightFeeCents(12), 1200);
});

test("bloqueia peso acima de 12 kg", () => {
  assert.throws(() => weightFeeCents(12.001), /excede o limite/);
});

test("calcula frete com frações e arredonda somente valores monetários", () => {
  const quote = calculateFreight({ weightKg: 2.5, distanceKm: 3.75, estimatedMinutes: 12.5 });
  assert.deepEqual(quote, {
    weightKg: 2.5,
    distanceKm: 3.75,
    estimatedMinutes: 12.5,
    weightCents: 500,
    distanceCents: 188,
    timeCents: 375,
    totalCents: 1063,
    currency: "BRL",
  });
});

test("distribui o frete normal sem perder centavos", () => {
  const split = splitNormalFreight(2000);
  assert.deepEqual(split, { courierCents: 1400, companyCents: 500, ermesCents: 100 });
  assert.equal(Object.values(split).reduce((sum, value) => sum + value, 0), 2000);
});
