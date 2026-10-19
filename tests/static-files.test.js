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

test("painel do cliente conecta catálogo e carrinho acessíveis à criação draft", async () => {
  const html = await readFile(resolve(publicRoot, "pages/painel.html"), "utf8");
  const script = await readFile(resolve(publicRoot, "js/painel.js"), "utf8");
  const cart = await readFile(resolve(publicRoot, "js/client-cart.js"), "utf8");

  assert.match(html, /data-client-companies-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-products-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-companies-list/);
  assert.match(html, /data-client-products-list/);
  assert.match(html, /data-client-cart-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-cart-message role="status" aria-live="polite" hidden/);
  assert.match(html, /data-client-cart-submit disabled/);
  assert.match(html, /data-client-destination-type checked/);
  assert.match(html, /data-client-manual-address hidden/);
  assert.match(html, /data-order-address-field="postalCode"/);
  assert.match(html, /data-client-recipient-type checked/);
  assert.match(html, /data-client-other-recipient hidden/);
  assert.match(html, /data-client-recipient-name/);
  assert.match(html, /Telefone n.o . obrigat.rio nem coletado/i);
  assert.match(html, /data-client-order-destination-summary/);
  assert.match(html, /data-client-order-recipient-summary/);
  assert.match(html, /src="\.\.\/js\/painel\.js" type="module"/);
  assert.match(script, /import \{ setupClientCatalog \} from "\.\/client-cart\.js"/);
  assert.match(script, /async function setupClient\(user\)/);
  assert.match(script, /if \(user\.role === "client"\) await setupClient\(user\)/);
  assert.match(cart, /api\("\/api\/client\/companies"\)/);
  assert.match(cart, /api\(`\/api\/client\/companies\/\$\{company\.id\}\/products`\)/);
  assert.match(cart, /api\("\/api\/client\/orders"/);
  assert.match(cart, /api\("\/api\/client\/default-address"/);
  assert.match(cart, /manualAddress\.hidden = !usesManualAddress/);
  assert.match(cart, /otherRecipient\.hidden = !usesOtherRecipient/);
  assert.match(cart, /input\.required = usesManualAddress/);
  assert.match(cart, /recipientName\.required = usesOtherRecipient/);
  const clientPanels = html.slice(
    html.indexOf('<section class="dashboard-section" data-client-panel'),
  );
  assert.doesNotMatch(clientPanels, /finalizar entrega|confirmar pedido/i);
});

test("painel conecta consulta e pagamento simulado dos pedidos confirmados", async () => {
  const html = await readFile(resolve(publicRoot, "pages/painel.html"), "utf8");
  const panel = await readFile(resolve(publicRoot, "js/painel.js"), "utf8");
  const payments = await readFile(resolve(publicRoot, "js/client-payments.js"), "utf8");

  assert.match(html, /data-client-payments-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-payment-message role="status" aria-live="polite" hidden/);
  assert.match(html, /data-client-payment-detail aria-busy="false" hidden/);
  assert.match(html, /data-client-payment-title tabindex="-1"/);
  assert.match(html, /data-client-payment-pay hidden/);
  assert.match(html, /pagamento . uma confirma..o simulada/i);
  assert.match(html, /n.o h. cobran.a real, cart.o, Pix ou gateway/i);
  assert.match(html, /pagamento garante uma entrega dispon.vel/i);
  assert.match(html, /c.digo permanece acess.vel ao cliente/i);
  assert.match(html, /data-delivery-panel="client"/);
  assert.match(html, /data-courier-financial/);
  assert.doesNotMatch(html, /\uFFFD/);
  assert.doesNotMatch(payments, /\uFFFD/);
  assert.match(panel, /import \{ setupClientPayments \} from "\.\/client-payments\.js"/);
  assert.match(panel, /setupClientPayments\(dependencies\)/);
  assert.match(payments, /api\("\/api\/client\/orders\/confirmed"\)/);
  assert.match(payments, /`\/api\/client\/orders\/confirmed\/\$\{orderId\}`/);
  assert.match(payments, /`\/api\/client\/orders\/\$\{orderId\}\/pay`/);
  assert.match(payments, /method: "POST"/);
  assert.doesNotMatch(payments, /card|cart.o|pix|qr code|gateway/i);
  const deliveries = await readFile(resolve(publicRoot, "js/delivery-panels.js"), "utf8");
  assert.match(deliveries, /api\("\/api\/courier\/financial-entries"\)/);
  assert.match(deliveries, /Total reembolsado/);
});

test("painel conecta consulta e edição acessíveis dos pedidos draft", async () => {
  const html = await readFile(resolve(publicRoot, "pages/painel.html"), "utf8");
  const panel = await readFile(resolve(publicRoot, "js/painel.js"), "utf8");
  const drafts = await readFile(resolve(publicRoot, "js/client-drafts.js"), "utf8");

  assert.match(html, /data-client-drafts-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-draft-editor-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-draft-products-status role="status" aria-live="polite"/);
  assert.match(html, /data-client-draft-message role="status" aria-live="polite" hidden/);
  assert.match(html, /data-client-draft-save disabled/);
  assert.match(html, /data-client-draft-title tabindex="-1"/);
  assert.match(panel, /import \{ setupClientDrafts \} from "\.\/client-drafts\.js"/);
  assert.match(panel, /setupClientDrafts\(dependencies\)/);
  assert.match(drafts, /api\("\/api\/client\/orders\/drafts"\)/);
  assert.match(drafts, /api\(`\/api\/client\/orders\/\$\{orderId\}`\)/);
  assert.match(drafts, /method: "PUT"/);
});

test("painel da empresa conecta consulta e confirmação comercial dos pedidos draft", async () => {
  const html = await readFile(resolve(publicRoot, "pages/painel.html"), "utf8");
  const panel = await readFile(resolve(publicRoot, "js/painel.js"), "utf8");
  const drafts = await readFile(resolve(publicRoot, "js/company-drafts.js"), "utf8");

  assert.ok(html.includes('data-company-drafts-status role="status" aria-live="polite"'));
  assert.ok(html.includes('data-company-drafts-list aria-label="Pedidos em rascunho para análise"'));
  assert.ok(html.includes('data-company-draft-detail aria-busy="false" hidden'));
  assert.ok(html.includes('data-company-draft-title tabindex="-1"'));
  assert.ok(html.includes('data-company-draft-message role="status" aria-live="polite" hidden'));
  assert.ok(html.includes('data-company-draft-confirm hidden'));
  assert.ok(html.indexOf("data-company-draft-message") < html.indexOf("data-company-draft-detail"));
  assert.ok(panel.includes('import { setupCompanyDrafts } from "./company-drafts.js"'));
  assert.ok(panel.includes("setupCompanyDrafts({ api, money, escapeHtml, showMessage })"));
  assert.ok(drafts.includes('api("/api/company/orders/drafts")'));
  assert.ok(drafts.includes("/api/company/orders/"));
  assert.ok(drafts.includes('method: "POST"'));
  assert.ok(drafts.includes("/confirm"));
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal(drafts.includes('method: "' + method + '"'), false);
});
