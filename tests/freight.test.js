import test from "node:test";
import assert from "node:assert/strict";
import { calculateFreight, DEFAULT_FREIGHT_CONFIG, splitNormalFreight, weightFeeCents } from "../src/freight.js";

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
  assert.throws(() => weightFeeCents(12.001, { ...DEFAULT_FREIGHT_CONFIG, maxWeightKg: 99 }), /excede o limite/);
});

test("calcula frete com frações e arredonda somente o total monetário", () => {
  const quote = calculateFreight({ weightKg: 2.5, distanceKm: 3.75, estimatedMinutes: 12.5 });
  assert.deepEqual(quote, {
    weightKg: 2.5,
    distanceKm: 3.75,
    estimatedMinutes: 12.5,
    weightCents: 500,
    perKmCents: 50,
    perMinuteCents: 30,
    distanceUnroundedCents: 187.5,
    timeUnroundedCents: 375,
    totalCents: 1063,
    currency: "BRL",
  });
});

test("não soma parcelas arredondadas quando isso adicionaria um centavo", () => {
  const quote = calculateFreight({ weightKg: 2.5, distanceKm: 3.75, estimatedMinutes: 12.55 });
  assert.equal(quote.distanceUnroundedCents, 187.5);
  assert.equal(quote.timeUnroundedCents, 376.5);
  assert.equal(quote.totalCents, 1064);
  assert.equal(quote.weightCents + Math.round(quote.distanceUnroundedCents) + Math.round(quote.timeUnroundedCents), 1065);
});

test("arredonda corretamente um meio centavo exato apesar do ponto flutuante", () => {
  const quote = calculateFreight({ weightKg: 2.5, distanceKm: 4.012, estimatedMinutes: 0.03 });
  assert.equal(quote.distanceUnroundedCents, 200.6);
  assert.equal(quote.timeUnroundedCents, 0.9);
  assert.equal(quote.totalCents, 702);
});

test("distribui o frete normal sem perder centavos", () => {
  const split = splitNormalFreight(2000);
  assert.deepEqual(split, { courierCents: 1400, companyCents: 500, ermesCents: 100 });
  assert.equal(Object.values(split).reduce((sum, value) => sum + value, 0), 2000);
});

test("cotação aceita total no limite seguro e rejeita overflow antes da conversão", () => {
  const input = { weightKg: 0.5, distanceKm: 0, estimatedMinutes: 0,
    config: { ...DEFAULT_FREIGHT_CONFIG, under1KgCents: Number.MAX_SAFE_INTEGER, perKmCents: 1 } };
  assert.equal(calculateFreight(input).totalCents, Number.MAX_SAFE_INTEGER);
  assert.throws(() => calculateFreight({ ...input, distanceKm: 1 }), /inteiros seguros/);
  assert.throws(() => calculateFreight({ weightKg: 1, distanceKm: 1e20, estimatedMinutes: 1 }), /inteiros seguros/);
});
