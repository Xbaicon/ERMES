export const DEFAULT_FREIGHT_CONFIG = Object.freeze({
  under1KgCents: 300,
  from1To3KgCents: 500,
  from3To8KgCents: 900,
  from8To12KgCents: 1200,
  perKmCents: 50,
  perMinuteCents: 30,
  maxWeightKg: 12,
});

export function weightFeeCents(weightKg, config = DEFAULT_FREIGHT_CONFIG) {
  const weight = Number(weightKg);
  if (!Number.isFinite(weight) || weight <= 0) throw new RangeError("O peso deve ser maior que zero.");
  if (weight > config.maxWeightKg) throw new RangeError("O pedido excede o limite de 12 kg.");
  if (weight < 1) return config.under1KgCents;
  if (weight < 3) return config.from1To3KgCents;
  if (weight < 8) return config.from3To8KgCents;
  return config.from8To12KgCents;
}

export function calculateFreight({ weightKg, distanceKm, estimatedMinutes, config = DEFAULT_FREIGHT_CONFIG }) {
  const distance = Number(distanceKm);
  const minutes = Number(estimatedMinutes);
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError("A distância deve ser válida.");
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("O tempo estimado deve ser válido.");

  const weightCents = weightFeeCents(weightKg, config);
  const distanceCents = Math.round(distance * config.perKmCents);
  const timeCents = Math.round(minutes * config.perMinuteCents);
  const totalCents = weightCents + distanceCents + timeCents;

  return {
    weightKg: Number(weightKg),
    distanceKm: distance,
    estimatedMinutes: minutes,
    weightCents,
    distanceCents,
    timeCents,
    totalCents,
    currency: "BRL",
  };
}

export function splitNormalFreight(totalCents) {
  const total = Number(totalCents);
  if (!Number.isInteger(total) || total < 0) throw new RangeError("O total deve ser informado em centavos.");
  const courierCents = Math.round(total * 0.7);
  const companyCents = Math.round(total * 0.25);
  const ermesCents = total - courierCents - companyCents;
  return { courierCents, companyCents, ermesCents };
}
