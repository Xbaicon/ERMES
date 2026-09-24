import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress } from "../src/address.js";

const validAddress = {
  postalCode: "01.001-000",
  state: " sp ",
  city: " São Paulo ",
  neighborhood: " Sé ",
  street: " Praça da Sé ",
  number: " 10 A ",
  complement: " Sala 2 ",
};

test("normaliza todos os campos do endereço e aceita complemento ausente", () => {
  assert.deepEqual(normalizeAddress(validAddress), {
    postalCode: "01001000",
    state: "SP",
    city: "São Paulo",
    neighborhood: "Sé",
    street: "Praça da Sé",
    number: "10 A",
    complement: "Sala 2",
  });
  assert.equal(normalizeAddress({ ...validAddress, complement: undefined }).complement, "");
});

test("não aceita campos obrigatórios apenas herdados do protótipo", () => {
  const inheritedAddress = Object.create(validAddress);
  assert.throws(() => normalizeAddress(inheritedAddress), /postalCode é obrigatório/);
});

for (const [name, body, expectedMessage] of [
  ["corpo nulo", null, /objeto de endereço/],
  ["corpo em lista", [], /objeto de endereço/],
  ["campo obrigatório ausente", { ...validAddress, city: undefined }, /city é obrigatório/],
  ["texto obrigatório vazio", { ...validAddress, street: "   " }, /street é obrigatório/],
  ["CEP com menos de oito dígitos", { ...validAddress, postalCode: "12345-67" }, /oito dígitos/],
  ["CEP com mais de oito dígitos", { ...validAddress, postalCode: "12345-6789" }, /oito dígitos/],
  ["estado fora do formato", { ...validAddress, state: "São Paulo" }, /duas letras/],
  ["campo inesperado", { ...validAddress, userId: 99 }, /Campos não permitidos: userId/],
  ["propriedade especial constructor", { ...validAddress, constructor: "intruso" }, /Campos não permitidos: constructor/],
  ["propriedade especial toString", { ...validAddress, toString: "intruso" }, /Campos não permitidos: toString/],
  ["propriedade especial __proto__", { ...validAddress, ["__proto__"]: "intruso" }, /Campos não permitidos: __proto__/],
  ["complemento não textual", { ...validAddress, complement: 12 }, /complement deve ser um texto/],
]) {
  test(`rejeita ${name}`, () => {
    assert.throws(() => normalizeAddress(body), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, expectedMessage);
      return true;
    });
  });
}
