import test from "node:test";
import assert from "node:assert/strict";
import { isEmail, isValidCnpj, isValidCpf, normalizeEmail, onlyDigits } from "../src/validation.js";

test("normaliza e-mail e dados numéricos", () => {
  assert.equal(normalizeEmail(" Pessoa@Exemplo.COM "), "pessoa@exemplo.com");
  assert.equal(onlyDigits("(71) 99999-0000"), "71999990000");
});

test("valida exemplos conhecidos de CPF e CNPJ", () => {
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("111.111.111-11"), false);
  assert.equal(isValidCnpj("00.000.000/0001-91"), true);
  assert.equal(isValidCnpj("11.111.111/1111-11"), false);
});

test("valida formato básico de e-mail", () => {
  assert.equal(isEmail("usuario@exemplo.com"), true);
  assert.equal(isEmail("usuario-sem-dominio"), false);
});
