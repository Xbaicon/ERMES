const addressFields = Object.freeze([
  "postalCode",
  "state",
  "city",
  "neighborhood",
  "street",
  "number",
  "complement",
]);

const requiredAddressFields = addressFields.filter((field) => field !== "complement");
const allowedAddressFields = new Set(addressFields);

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function requiredText(body, field) {
  if (!Object.hasOwn(body, field) || typeof body[field] !== "string" || !body[field].trim()) {
    throw badRequest(`O campo ${field} é obrigatório e deve ser um texto não vazio.`);
  }
  return body[field].trim();
}

export function normalizeAddress(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw badRequest("O corpo da requisição deve ser um objeto de endereço.");
  }

  const unexpected = Object.keys(body).filter((field) => !allowedAddressFields.has(field));
  if (unexpected.length) throw badRequest(`Campos não permitidos: ${unexpected.join(", ")}.`);

  const normalized = Object.fromEntries(requiredAddressFields.map((field) => [field, requiredText(body, field)]));
  normalized.postalCode = normalized.postalCode.replace(/\D/g, "");
  if (!/^\d{8}$/.test(normalized.postalCode)) {
    throw badRequest("O campo postalCode deve possuir exatamente oito dígitos.");
  }

  normalized.state = normalized.state.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized.state)) {
    throw badRequest("O campo state deve possuir exatamente duas letras.");
  }

  const hasComplement = Object.hasOwn(body, "complement") && body.complement !== undefined;
  if (hasComplement && typeof body.complement !== "string") {
    throw badRequest("O campo complement deve ser um texto.");
  }
  normalized.complement = hasComplement ? body.complement.trim() : "";
  return normalized;
}
