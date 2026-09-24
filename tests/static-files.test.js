import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(projectRoot, "public");
const htmlFiles = ["index.html", "pages/login.html", "pages/cliente.html", "pages/empresa.html", "pages/painel.html"];

test("todas as referências locais de HTML existem", async () => {
  for (const relativeFile of htmlFiles) {
    const absoluteFile = resolve(publicRoot, relativeFile);
    const html = await readFile(absoluteFile, "utf8");
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    for (const reference of references) {
      if (/^(?:https?:|mailto:|tel:|#)/.test(reference)) continue;
      const cleanReference = reference.split(/[?#]/)[0];
      await assert.doesNotReject(access(resolve(dirname(absoluteFile), cleanReference)), `${relativeFile}: ${reference}`);
    }
  }
});

test("a interface não anuncia funcionalidades fora do escopo", async () => {
  for (const relativeFile of htmlFiles) {
    const html = await readFile(resolve(publicRoot, relativeFile), "utf8");
    assert.doesNotMatch(html, /entrega(?:s)? agendada(?:s)?/i, relativeFile);
    assert.doesNotMatch(html, /motoboy aut[oô]nomo/i, relativeFile);
  }
});

test("arquivos JavaScript referenciados usam a extensão correta", async () => {
  for (const relativeFile of htmlFiles) {
    const html = await readFile(resolve(publicRoot, relativeFile), "utf8");
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0, `${relativeFile} deve carregar JavaScript`);
    assert.ok(scripts.every((script) => extname(script) === ".js"));
  }
});

test("formulário de endereço inicia bloqueado e expõe mensagens acessíveis", async () => {
  const html = await readFile(resolve(publicRoot, "pages/painel.html"), "utf8");
  assert.match(html, /data-default-address-submit disabled/);
  assert.match(html, /data-default-address-message role="status" aria-live="polite"/);
});
