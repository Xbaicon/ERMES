export function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(normalizeEmail(value));
}

export function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length, factor) => {
    let total = 0;
    for (let i = 0; i < length; i += 1) total += Number(cpf[i]) * (factor - i);
    const remainder = (total * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9, 10) === Number(cpf[9]) && digit(10, 11) === Number(cpf[10]);
}

export function isValidCnpj(value) {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calculate = (base) => {
    let factor = base.length - 7;
    let total = 0;
    for (const character of base) {
      total += Number(character) * factor;
      factor = factor === 2 ? 9 : factor - 1;
    }
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = calculate(cnpj.slice(0, 12));
  const second = calculate(cnpj.slice(0, 12) + first);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}

export function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || String(body[field]).trim() === "");
  if (missing.length) {
    const error = new Error(`Campos obrigatórios: ${missing.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
}

export function assertPassword(password) {
  if (String(password || "").length < 8) {
    const error = new Error("A senha deve possuir pelo menos 8 caracteres.");
    error.statusCode = 400;
    throw error;
  }
}
