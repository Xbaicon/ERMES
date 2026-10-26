export const DEFAULT_FREIGHT_CONFIG = Object.freeze({
  under1KgCents: 300,
  from1To3KgCents: 500,
  from3To8KgCents: 900,
  from8To12KgCents: 1200,
  perKmCents: 50,
  perMinuteCents: 30,
  maxWeightKg: 12,
});

export const MAX_ORDER_WEIGHT_KG = 12;

export function weightFeeCents(weightKg, config = DEFAULT_FREIGHT_CONFIG) {
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) throw new RangeError("O peso deve ser maior que zero.");
  if (weight > MAX_ORDER_WEIGHT_KG) throw new RangeError("O pedido excede o limite de 12 kg.");
  if (weight < 1) return config.under1KgCents;
  if (weight < 3) return config.from1To3KgCents;
  if (weight < 8) return config.from3To8KgCents;
  return config.from8To12KgCents;
}

function decimalParts(value) {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [integer, fraction = ""] = mantissa.split(".");
  const decimalPlaces = fraction.length - Number(exponent);
  const digits = BigInt(integer + fraction);
  return decimalPlaces < 0
    ? { numerator: digits * 10n ** BigInt(-decimalPlaces), decimalPlaces: 0 }
    : { numerator: digits, decimalPlaces };
}

export function calculateFreight({ weightKg, distanceKm, estimatedMinutes, config = DEFAULT_FREIGHT_CONFIG }) {
  const distance = Number(distanceKm);
  const minutes = Number(estimatedMinutes);
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError("A distância deve ser válida.");
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("O tempo estimado deve ser válido.");

  const weightCents = weightFeeCents(weightKg, config);
  const distanceParts = decimalParts(distance);
  const timeParts = decimalParts(minutes);
  const distanceNumerator = distanceParts.numerator * BigInt(config.perKmCents);
  const timeNumerator = timeParts.numerator * BigInt(config.perMinuteCents);
  const distanceUnroundedCents = Number(distanceNumerator) / 10 ** distanceParts.decimalPlaces;
  const timeUnroundedCents = Number(timeNumerator) / 10 ** timeParts.decimalPlaces;

  const decimalPlaces = Math.max(distanceParts.decimalPlaces, timeParts.decimalPlaces);
  const scale = 10n ** BigInt(decimalPlaces);
  const exactTotal = BigInt(weightCents) * scale
    + distanceNumerator * 10n ** BigInt(decimalPlaces - distanceParts.decimalPlaces)
    + timeNumerator * 10n ** BigInt(decimalPlaces - timeParts.decimalPlaces);
  const roundedTotal = (2n * exactTotal + scale) / (2n * scale);
  if (roundedTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("O total do frete excede o limite de centavos inteiros seguros.");
  }
  const totalCents = Number(roundedTotal);

  return {
    weightKg: Number(weightKg),
    distanceKm: distance,
    estimatedMinutes: minutes,
    weightCents,
    perKmCents: config.perKmCents,
    perMinuteCents: config.perMinuteCents,
    distanceUnroundedCents,
    timeUnroundedCents,
    totalCents,
    currency: "BRL",
  };
}

export function splitNormalFreight(totalCents) {
  if (typeof totalCents !== "number" || !Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new RangeError("O total deve ser informado em centavos inteiros seguros.");
  }

  const totalBigInt = BigInt(totalCents);
  const shares = [
    { key: "courierCents", percentage: 70n, priority: 0 },
    { key: "companyCents", percentage: 25n, priority: 1 },
    { key: "ermesCents", percentage: 5n, priority: 2 },
  ].map((share) => {
    const exactNumerator = totalBigInt * share.percentage;
    return {
      ...share,
      cents: exactNumerator / 100n,
      remainder: exactNumerator % 100n,
    };
  });

  let remaining = totalBigInt - shares.reduce((sum, share) => sum + share.cents, 0n);
  const byLargestRemainder = [...shares].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.priority - right.priority;
  });
  for (const share of byLargestRemainder) {
    if (remaining === 0n) break;
    share.cents += 1n;
    remaining -= 1n;
  }

  return Object.fromEntries(shares.map(({ key, cents }) => [key, Number(cents)]));
}
