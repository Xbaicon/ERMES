import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("chat por Pedido entre cliente e empresa", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-order-chat-test-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?chat=${Date.now()}`);
  const { db } = await import("../src/database.js");
  const { hashConfirmationCode, hashPassword } = await import("../src/security.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, method = "GET", body } = {}) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const passwordHash = hashPassword("Senha123!");
  const company1 = Number(db.prepare(`INSERT INTO companies
    (name, cnpj, email, address_json) VALUES (?, ?, ?, '{}')`)
    .run("Empresa Chat", "10101010000110", "empresa.chat@ermes.local").lastInsertRowid);
  const company2 = Number(db.prepare(`INSERT INTO companies
    (name, cnpj, email, address_json) VALUES (?, ?, ?, '{}')`)
    .run("Outra Empresa", "20202020000120", "outra.chat@ermes.local").lastInsertRowid);
  const createUser = (role, email, companyId = null) => Number(db.prepare(`INSERT INTO users
    (company_id, role, full_name, email, password_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(companyId, role, email, email, passwordHash).lastInsertRowid);
  const client1 = createUser("client", "cliente.chat@ermes.local");
  const client2 = createUser("client", "cliente.outro.chat@ermes.local");
  const companyUser1 = createUser("company", "empresa.usuario.chat@ermes.local", company1);
  const companyUser2 = createUser("company", "outra.usuario.chat@ermes.local", company2);
  const courier = createUser("courier", "motoboy.chat@ermes.local", company1);
  const admin = createUser("platform_admin", "admin.chat@ermes.local");
  db.prepare("INSERT INTO couriers (user_id, vehicle_type) VALUES (?, 'motorcycle')").run(courier);

  const createOrder = (clientId, companyId, status = "draft") => Number(db.prepare(`INSERT INTO orders
    (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json)
    VALUES (?, ?, ?, '{}', '{"type":"self","name":"Cliente"}')`)
    .run(clientId, companyId, status).lastInsertRowid);
  const ownOrder = createOrder(client1, company1);
  const otherClientOrder = createOrder(client2, company1);
  const otherCompanyOrder = createOrder(client1, company2);
  const tiedOrder = createOrder(client1, company1);
  const terminalOrders = ["completed", "cancelled", "returned"].map((status) => ({
    orderId: createOrder(client1, company1, "confirmed"), status,
  }));

  async function login(email) {
    const response = await request("/api/auth/login", {
      method: "POST", body: { email, password: "Senha123!" },
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const cookies = {
    client1: await login("cliente.chat@ermes.local"),
    client2: await login("cliente.outro.chat@ermes.local"),
    company1: await login("empresa.usuario.chat@ermes.local"),
    company2: await login("outra.usuario.chat@ermes.local"),
    courier: await login("motoboy.chat@ermes.local"),
    admin: await login("admin.chat@ermes.local"),
  };
  const clientChat = (orderId) => `/api/client/orders/${orderId}/chat`;
  const companyChat = (orderId) => `/api/company/orders/${orderId}/chat`;
  const send = (path, cookie, message) => request(path, {
    cookie, method: "POST", body: { message },
  });

  await context.test("histórico vazio é consultável e listagens são isoladas", async () => {
    const empty = await request(clientChat(ownOrder), { cookie: cookies.client1 });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { chat: {
      orderId: ownOrder, orderStatus: "draft", deliveryStatus: null,
      readOnly: false, messages: [],
    } });
    const clientOrders = (await (await request("/api/client/order-chats", {
      cookie: cookies.client1,
    })).json()).orders;
    assert.ok(clientOrders.some(({ orderId }) => orderId === ownOrder));
    assert.ok(clientOrders.some(({ orderId }) => orderId === otherCompanyOrder));
    assert.equal(clientOrders.some(({ orderId }) => orderId === otherClientOrder), false);
    const companyOrders = (await (await request("/api/company/order-chats", {
      cookie: cookies.company1,
    })).json()).orders;
    assert.ok(companyOrders.some(({ orderId }) => orderId === ownOrder));
    assert.ok(companyOrders.some(({ orderId }) => orderId === otherClientOrder));
    assert.equal(companyOrders.some(({ orderId }) => orderId === otherCompanyOrder), false);
  });

  await context.test("cliente e empresa enviam mensagens distintas com remetente da sessão", async () => {
    const text = "  Mesma mensagem legítima.  ";
    const fromClient = await send(clientChat(ownOrder), cookies.client1, text);
    const fromCompany = await send(companyChat(ownOrder), cookies.company1, text);
    assert.equal(fromClient.status, 201);
    assert.equal(fromCompany.status, 201);
    assert.deepEqual((await fromClient.json()).message.senderRole, "client");
    assert.deepEqual((await fromCompany.json()).message.senderRole, "company");
    const history = (await (await request(companyChat(ownOrder), {
      cookie: cookies.company1,
    })).json()).chat.messages;
    assert.equal(history.length, 2);
    assert.deepEqual(history.map(({ senderRole, message }) => ({ senderRole, message })), [
      { senderRole: "client", message: "Mesma mensagem legítima." },
      { senderRole: "company", message: "Mesma mensagem legítima." },
    ]);
    assert.ok(history[0].id < history[1].id);
  });

  await context.test("ordenação usa ID como desempate de timestamps iguais", async () => {
    const insert = db.prepare(`INSERT INTO order_chat_messages
      (order_id, sender_user_id, sender_role, content, created_at)
      VALUES (?, ?, ?, ?, '2026-10-20 10:00:00')`);
    const first = Number(insert.run(tiedOrder, client1, "client", "Primeira").lastInsertRowid);
    const second = Number(insert.run(tiedOrder, companyUser1, "company", "Segunda").lastInsertRowid);
    const messages = (await (await request(clientChat(tiedOrder), {
      cookie: cookies.client1,
    })).json()).chat.messages;
    assert.deepEqual(messages.map(({ id }) => id), [first, second]);
    assert.equal(messages[0].sentAt, messages[1].sentAt);
  });

  await context.test("envios próximos de cliente e empresa persistem separadamente", async () => {
    const responses = await Promise.all([
      send(clientChat(ownOrder), cookies.client1, "Envio próximo"),
      send(companyChat(ownOrder), cookies.company1, "Envio próximo"),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [201, 201]);
    const history = (await (await request(clientChat(ownOrder), {
      cookie: cookies.client1,
    })).json()).chat.messages;
    assert.equal(history.filter(({ message }) => message === "Envio próximo").length, 2);
  });

  await context.test("isolamento retorna 404 sem revelar Pedido alheio", async () => {
    for (const [path, cookie] of [
      [clientChat(otherClientOrder), cookies.client1],
      [companyChat(otherCompanyOrder), cookies.company1],
    ]) {
      assert.equal((await request(path, { cookie })).status, 404);
      assert.equal((await send(path, cookie, "Não autorizado")).status, 404);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM order_chat_messages
      WHERE content = 'Não autorizado'`).get().total, 0);
  });

  await context.test("não autenticado, motoboy e administrador não acessam chat", async () => {
    for (const path of [clientChat(ownOrder), companyChat(ownOrder),
      "/api/client/order-chats", "/api/company/order-chats"]) {
      assert.equal((await request(path)).status, 401);
    }
    for (const cookie of [cookies.courier, cookies.admin]) {
      assert.equal((await request(clientChat(ownOrder), { cookie })).status, 403);
      assert.equal((await request(companyChat(ownOrder), { cookie })).status, 403);
      assert.equal((await send(clientChat(ownOrder), cookie, "Bloqueada")).status, 403);
      assert.equal((await send(companyChat(ownOrder), cookie, "Bloqueada")).status, 403);
    }
  });

  await context.test("valida corpo estrito, identificador e limite técnico", async () => {
    const invalidBodies = [null, [], {}, { message: 123 }, { message: "   " },
      { message: "válida", senderRole: "company" }, { message: "x".repeat(2001) }];
    for (const body of invalidBodies) {
      const response = await request(clientChat(ownOrder), {
        cookie: cookies.client1, method: "POST", body,
      });
      assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 100));
    }
    assert.equal((await request("/api/client/orders/abc/chat", {
      cookie: cookies.client1,
    })).status, 400);
    assert.equal((await request("/api/client/orders/999999/chat", {
      cookie: cookies.client1,
    })).status, 404);
  });

  await context.test("Pedido terminal mantém GET e rejeita POST em todos os estados terminais", async () => {
    for (const item of terminalOrders) {
      assert.equal((await send(clientChat(item.orderId), cookies.client1,
        `Antes de ${item.status}`)).status, 201);
      db.prepare("INSERT INTO deliveries (order_id, status) VALUES (?, ?)")
        .run(item.orderId, item.status);
      const response = await request(clientChat(item.orderId), { cookie: cookies.client1 });
      assert.equal(response.status, 200);
      const chat = (await response.json()).chat;
      assert.equal(chat.readOnly, true);
      assert.equal(chat.deliveryStatus, item.status);
      assert.equal(chat.messages.length, 1);
      assert.equal((await send(companyChat(item.orderId), cookies.company1,
        "Depois do encerramento")).status, 409);
      assert.throws(() => db.prepare(`INSERT INTO order_chat_messages
        (order_id, sender_user_id, sender_role, content) VALUES (?, ?, 'client', 'Direta')`)
        .run(item.orderId, client1), /read-only/);
    }
  });

  await context.test("histórico é imutável e não depende do nome cadastral atual", async () => {
    const before = (await (await request(clientChat(ownOrder), {
      cookie: cookies.client1,
    })).json()).chat.messages;
    db.prepare("UPDATE users SET full_name = 'Nome alterado' WHERE id = ?").run(client1);
    const after = (await (await request(clientChat(ownOrder), {
      cookie: cookies.client1,
    })).json()).chat.messages;
    assert.deepEqual(after, before);
    const messageId = before[0].id;
    assert.throws(() => db.prepare("UPDATE order_chat_messages SET content = 'Editada' WHERE id = ?")
      .run(messageId), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM order_chat_messages WHERE id = ?")
      .run(messageId), /append-only/);
    assert.equal((await request(clientChat(ownOrder), {
      cookie: cookies.client1, method: "PATCH", body: { message: "Editada" },
    })).status, 404);
    assert.equal((await request(clientChat(ownOrder), {
      cookie: cookies.client1, method: "DELETE",
    })).status, 404);
  });

  await context.test("banco rejeita remetente que não pertence ao Pedido", () => {
    assert.throws(() => db.prepare(`INSERT INTO order_chat_messages
      (order_id, sender_user_id, sender_role, content) VALUES (?, ?, 'client', 'Inválida')`)
      .run(ownOrder, client2), /does not belong/);
    assert.throws(() => db.prepare(`INSERT INTO order_chat_messages
      (order_id, sender_user_id, sender_role, content) VALUES (?, ?, 'company', 'Inválida')`)
      .run(ownOrder, companyUser2), /does not belong/);
  });

  await context.test("POST concorrente com conclusão, cancelamento e retorno respeita terminalidade", async () => {
    db.exec(`
      CREATE TEMP TABLE chat_terminal_race_audit (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        operation TEXT NOT NULL
      );
      CREATE TEMP TRIGGER audit_chat_terminal_race_message
        AFTER INSERT ON order_chat_messages
        BEGIN
          INSERT INTO chat_terminal_race_audit (order_id, operation)
          VALUES (NEW.order_id, 'message');
        END;
      CREATE TEMP TRIGGER audit_chat_terminal_race_delivery
        AFTER UPDATE OF status ON deliveries
        WHEN NEW.status IN ('completed', 'cancelled', 'returned')
          AND OLD.status NOT IN ('completed', 'cancelled', 'returned')
        BEGIN
          INSERT INTO chat_terminal_race_audit (order_id, operation)
          VALUES (NEW.order_id, 'terminal');
        END;
    `);
    const createRaceOrder = () => createOrder(client1, company1, "confirmed");
    const completionOrder = createRaceOrder();
    const completionDelivery = Number(db.prepare(`INSERT INTO deliveries
      (order_id, courier_id, status, confirmation_code_hash)
      VALUES (?, ?, 'awaiting_confirmation', ?)`)
      .run(completionOrder, courier, hashConfirmationCode("123456")).lastInsertRowid);
    const cancellationOrder = createRaceOrder();
    const cancellationDelivery = Number(db.prepare(`INSERT INTO deliveries (order_id, status)
      VALUES (?, 'available')`).run(cancellationOrder).lastInsertRowid);

    async function assertTerminalRace({
      orderId, deliveryId, chatPath, chatCookie, terminalPath, terminalCookie,
      terminalBody, terminalStatus, terminalEvent,
    }) {
      const text = `Mensagem concorrente ${orderId}`;
      const [messageResponse, terminalResponse] = await Promise.all([
        send(chatPath, chatCookie, text),
        request(terminalPath, { cookie: terminalCookie, method: "POST", body: terminalBody }),
      ]);
      assert.equal(terminalResponse.status, 200);
      assert.ok([201, 409].includes(messageResponse.status));
      assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?")
        .get(deliveryId).status, terminalStatus);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
        WHERE delivery_id = ? AND event_type = ?`).get(deliveryId, terminalEvent).total, 1);
      const persisted = db.prepare(`SELECT COUNT(*) AS total FROM order_chat_messages
        WHERE order_id = ? AND content = ?`).get(orderId, text).total;
      const audit = db.prepare(`SELECT operation FROM chat_terminal_race_audit
        WHERE order_id = ? ORDER BY id`).all(orderId).map(({ operation }) => operation);
      if (messageResponse.status === 201) {
        assert.equal(persisted, 1);
        assert.deepEqual(audit, ["message", "terminal"]);
      } else {
        assert.equal(persisted, 0);
        assert.deepEqual(audit, ["terminal"]);
      }
    }

    await assertTerminalRace({
      orderId: completionOrder,
      deliveryId: completionDelivery,
      chatPath: clientChat(completionOrder),
      chatCookie: cookies.client1,
      terminalPath: `/api/courier/deliveries/${completionDelivery}/confirm`,
      terminalCookie: cookies.courier,
      terminalBody: { code: "123456" },
      terminalStatus: "completed",
      terminalEvent: "delivery_completed",
    });
    await assertTerminalRace({
      orderId: cancellationOrder,
      deliveryId: cancellationDelivery,
      chatPath: clientChat(cancellationOrder),
      chatCookie: cookies.client1,
      terminalPath: `/api/client/deliveries/${cancellationDelivery}/cancel`,
      terminalCookie: cookies.client1,
      terminalBody: {},
      terminalStatus: "cancelled",
      terminalEvent: "client_cancelled_before_pickup",
    });
    const returnOrder = createRaceOrder();
    const returnDelivery = Number(db.prepare(`INSERT INTO deliveries
      (order_id, courier_id, status, return_reason, return_reported_at)
      VALUES (?, ?, 'awaiting_return_confirmation', 'recipient_absent', CURRENT_TIMESTAMP)`)
      .run(returnOrder, courier).lastInsertRowid);
    await assertTerminalRace({
      orderId: returnOrder,
      deliveryId: returnDelivery,
      chatPath: companyChat(returnOrder),
      chatCookie: cookies.company1,
      terminalPath: `/api/company/deliveries/${returnDelivery}/confirm-return`,
      terminalCookie: cookies.company1,
      terminalBody: {},
      terminalStatus: "returned",
      terminalEvent: "return_confirmed",
    });
  });
});
