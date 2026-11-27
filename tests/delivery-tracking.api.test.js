import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

test("rastreamento geográfico: autorização, ciclo, integridade e histórico", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-tracking-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?tracking=${Date.now()}`);
  const { db } = await import("../src/database.js");
  const { hashToken } = await import("../src/security.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const company = (name) => Number(db.prepare(`INSERT INTO companies (name, cnpj, email)
    VALUES (?, ?, ?)`).run(name, name === "A" ? "11111111000111" : "22222222000122",
    `${name}@example.test`).lastInsertRowid);
  const companyA = company("A"), companyB = company("B");
  const user = (role, name, companyId = null) => Number(db.prepare(`INSERT INTO users
    (company_id, role, company_profile, full_name, email, password_hash)
    VALUES (?, ?, ?, ?, ?, 'hash')`).run(companyId, role,
    role === "company" ? "RESPONSAVEL" : null, name, `${name}@example.test`).lastInsertRowid);
  const ids = {
    client: user("client", "client"), otherClient: user("client", "other-client"),
    company: user("company", "company", companyA), otherCompany: user("company", "other-company", companyB),
    courier: user("courier", "courier", companyA), replacement: user("courier", "replacement", companyA),
    otherCourier: user("courier", "other-courier", companyB),
  };
  for (const id of [ids.courier, ids.replacement, ids.otherCourier]) {
    db.prepare("INSERT INTO couriers (user_id, vehicle_type, is_online) VALUES (?, 'motorcycle', 1)").run(id);
  }
  const cookies = Object.fromEntries(Object.entries(ids).map(([name, id]) => {
    const token = `tracking-${name}`;
    db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES (?, ?, datetime('now', '+1 day'))`).run(hashToken(token), id);
    return [name, `ermes_session=${token}`];
  }));
  const request = (path, role, method = "GET", body) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(role ? { Cookie: cookies[role] } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const createDelivery = (clientId = ids.client, companyId = companyA,
    initialStatus = "available", initialCourierId = null) => {
    const orderId = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, recipient_snapshot_json, payment_status, confirmed_at)
      VALUES (?, ?, 'confirmed', '{"type":"self","name":"Client"}', 'paid', CURRENT_TIMESTAMP)`)
      .run(clientId, companyId).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO deliveries (order_id, status, courier_id)
      VALUES (?, ?, ?)`).run(orderId, initialStatus, initialCourierId).lastInsertRowid);
  };
  const id = createDelivery();
  const courierPath = (suffix) => `/api/courier/deliveries/${id}/${suffix}`;
  const position = (capturedAt = new Date().toISOString(), latitude = -23.55, longitude = -46.63) =>
    ({ latitude, longitude, capturedAt, accuracyMeters: 8 });
  const send = (role, body) => request(courierPath("positions"), role, "POST", body);
  const tracking = async (role = "company") => {
    const response = await request(`/api/${role === "company" ? "company" : "client"}/deliveries/${id}/tracking`, role);
    assert.equal(response.status, 200);
    return (await response.json()).tracking;
  };
  const action = (role, name, body = {}) => request(courierPath(name), role, "POST", body);

  await context.test("aceite abre período e impede acesso ou escrita de outro participante", async () => {
    assert.equal((await action("courier", "accept")).status, 200);
    assert.equal((await request(courierPath("tracking-state"), "courier")).status, 200);
    assert.equal((await send("client", position())).status, 403);
    assert.equal((await send("company", position())).status, 403);
    assert.equal((await send("replacement", position())).status, 404);
    assert.equal((await send("otherCourier", position())).status, 404);
    assert.equal((await send(null, position())).status, 401);
    assert.equal((await request(`/api/client/deliveries/${id}/tracking`, "otherClient")).status, 404);
    assert.equal((await request(`/api/company/deliveries/${id}/tracking`, "otherCompany")).status, 404);
    assert.equal((await request(courierPath("tracking-state"), "replacement")).status, 404);
    assert.equal((await tracking("client")).state, "unavailable");
  });

  await context.test("valida coordenadas, precisão, horário e preserva captura original", async () => {
    for (const bad of [
      position(new Date().toISOString(), 91), position(new Date().toISOString(), 0, -181),
      { ...position(), latitude: "-23" }, { ...position(), latitude: null },
      { ...position(), accuracyMeters: -1 }, { ...position(), accuracyMeters: "8" },
      { ...position(), capturedAt: "not-a-date" },
      position(new Date(Date.now() + 31_000).toISOString()),
    ]) assert.equal((await send("courier", bad)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_positions").get().n, 0);
    const capturedAt = new Date().toISOString();
    const first = await send("courier", position(capturedAt));
    assert.equal(first.status, 201);
    const result = await first.json();
    assert.equal(result.position.capturedAt, capturedAt);
    assert.equal(result.duplicate, false);
    assert.equal((await send("courier", position(capturedAt))).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_positions").get().n, 1);
    assert.equal(db.prepare("SELECT received_at AS receivedAt FROM delivery_tracking_positions WHERE id = ?")
      .get(result.position.id).receivedAt, result.position.receivedAt);
    assert.equal((await send("courier", position(new Date(Date.parse(capturedAt) + 1).toISOString()))).status, 201);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_positions").get().n, 2);
    const activePeriod = db.prepare(`SELECT id FROM delivery_tracking_periods
      WHERE delivery_id = ? AND ended_at IS NULL`).get(id).id;
    for (const [latitude, capture] of [[91, capturedAt], [0, "invalid"],
      [0, new Date(Date.now() + 60_000).toISOString()]]) {
      assert.throws(() => db.prepare(`INSERT INTO delivery_tracking_positions
        (delivery_id, period_id, courier_id, latitude, longitude, captured_at, received_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)`).run(id, activePeriod, ids.courier,
        latitude, capture, new Date().toISOString()));
    }
    const beforeStart = position(new Date(Date.now() - 60_000).toISOString());
    assert.equal((await send("courier", beforeStart)).status, 400);
  });

  await context.test("posição atrasada não regride corrente nem renova atualidade", async () => {
    const current = (await tracking()).latestPosition;
    const periodId = current.periodId;
    const startedAt = db.prepare("SELECT started_at AS startedAt FROM delivery_tracking_periods WHERE id = ?")
      .get(periodId).startedAt;
    const old = position(startedAt, -23.56, -46.64);
    assert.equal((await send("courier", old)).status, 201);
    let snapshot = await tracking();
    assert.equal(snapshot.latestPosition.id, current.id);
    assert.deepEqual(snapshot.periods[0].positions.map((p) => p.capturedAt),
      snapshot.periods[0].positions.map((p) => p.capturedAt).toSorted());
    assert.equal((await send("courier", old)).status, 200);
    assert.equal((await tracking()).latestPosition.id, current.id);
    const isolated = createDelivery(ids.client, companyA, "heading_to_pickup", ids.replacement);
    db.prepare(`INSERT INTO delivery_tracking_periods (delivery_id, courier_id, started_at)
      VALUES (?, ?, ?)`).run(isolated, ids.replacement, new Date(Date.now() - 300_000).toISOString());
    const stalePosition = position(new Date(Date.now() - 180_000).toISOString());
    const stale = await request(`/api/courier/deliveries/${isolated}/positions`, "replacement", "POST",
      stalePosition);
    assert.equal(stale.status, 201);
    const status = await request(`/api/client/deliveries/${isolated}/tracking`, "client");
    assert.equal((await status.json()).tracking.state, "stale");
    assert.equal((await request(`/api/courier/deliveries/${isolated}/positions`, "replacement", "POST",
      stalePosition)).status, 200);
    const stillStale = await request(`/api/client/deliveries/${isolated}/tracking`, "client");
    assert.equal((await stillStale.json()).tracking.state, "stale");
    db.prepare("UPDATE deliveries SET status = 'cancelled', courier_id = NULL WHERE id = ?").run(isolated);
  });

  await context.test("pausa, retomada, retorno físico e troca preservam períodos", async () => {
    assert.equal((await action("courier", "arrive-pickup")).status, 200);
    let snapshot = await tracking();
    assert.equal(snapshot.state, "paused");
    assert.equal(snapshot.periods[0].endKind, "paused");
    assert.equal((await send("courier", position())).status, 409);
    assert.equal((await action("courier", "collect")).status, 200);
    snapshot = await tracking();
    assert.equal(snapshot.periods.length, 2);
    assert.equal(snapshot.periods[1].courierId, ids.courier);
    assert.equal((await send("courier", position())).status, 201);
    assert.equal((await action("courier", "arrive-destination")).status, 200);
    assert.equal((await tracking()).state, "paused");
    assert.equal((await action("courier", "fail", { reason: "Falha mecânica" })).status, 200);
    assert.equal((await tracking()).periods.length, 3);
    assert.equal((await send("courier", position())).status, 201);
    assert.equal((await action("courier", "report-return")).status, 200);
    assert.equal((await send("courier", position())).status, 409);
    assert.equal((await request(`/api/company/deliveries/${id}/confirm-return`, "company", "POST", {})).status, 200);
    assert.equal((await action("replacement", "accept")).status, 200);
    snapshot = await tracking();
    assert.equal(snapshot.periods.length, 4);
    assert.equal(snapshot.periods[3].courierId, ids.replacement);
    assert.equal(snapshot.state, "unavailable");
    assert.ok(snapshot.latestPosition);
    assert.equal((await send("courier", position())).status, 404);
    assert.equal((await send("replacement", position())).status, 201);
    assert.equal((await tracking()).state, "updated");
    assert.equal(snapshot.periods[0].positions.length, 3);
  });

  await context.test("revalidação e encerramento revogam cliente, mantêm empresa", async () => {
    db.prepare("UPDATE deliveries SET status = 'awaiting_revalidation', courier_id = NULL WHERE id = ?").run(id);
    assert.equal((await send("replacement", position())).status, 404);
    assert.equal((await tracking()).state, "paused");
    db.prepare("UPDATE deliveries SET status = 'available' WHERE id = ?").run(id);
    assert.equal((await action("courier", "accept")).status, 200);
    assert.equal((await tracking()).periods.length, 5);
    db.prepare("UPDATE deliveries SET status = 'cancelled', courier_id = NULL WHERE id = ?").run(id);
    assert.equal((await request(`/api/client/deliveries/${id}/tracking`, "client")).status, 404);
    assert.equal((await request(courierPath("tracking-state"), "courier")).status, 404);
    const snapshot = await tracking();
    assert.equal(snapshot.state, "ended");
    assert.equal(snapshot.periods.length, 5);
    assert.equal(snapshot.periods[4].endKind, "ended");
  });

  await context.test("rollback operacional e barreira contra SQL direto", async () => {
    const invalidReturn = createDelivery();
    db.prepare("UPDATE deliveries SET status = 'returning', courier_id = ? WHERE id = ?")
      .run(ids.courier, invalidReturn);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_periods WHERE delivery_id = ?")
      .get(invalidReturn).n, 0);
    assert.equal((await request(`/api/courier/deliveries/${invalidReturn}/positions`, "courier", "POST",
      position())).status, 409);
    db.prepare("UPDATE deliveries SET status = 'cancelled', courier_id = NULL WHERE id = ?")
      .run(invalidReturn);
    const rollbackId = createDelivery();
    db.exec(`CREATE TRIGGER fail_tracking_period BEFORE INSERT ON delivery_tracking_periods
      WHEN NEW.delivery_id = ${rollbackId}
      BEGIN SELECT RAISE(ABORT, 'forced tracking failure'); END`);
    assert.equal((await request(`/api/courier/deliveries/${rollbackId}/accept`, "courier", "POST", {})).status, 500);
    db.exec("DROP TRIGGER fail_tracking_period");
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(rollbackId).status, "available");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_periods WHERE delivery_id = ?")
      .get(rollbackId).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE delivery_id = ?")
      .get(rollbackId).n, 0);
    const closed = db.prepare("SELECT id, delivery_id, courier_id FROM delivery_tracking_periods WHERE delivery_id = ? LIMIT 1")
      .get(id);
    assert.throws(() => db.prepare(`INSERT INTO delivery_tracking_positions
      (delivery_id, period_id, courier_id, latitude, longitude, captured_at, received_at)
      VALUES (?, ?, ?, 0, 0, ?, ?)`).run(closed.delivery_id, closed.id, closed.courier_id,
      new Date().toISOString(), new Date().toISOString()));
    assert.throws(() => db.prepare(`INSERT INTO delivery_tracking_periods
      (delivery_id, courier_id, started_at) VALUES (?, ?, ?)`)
      .run(id, ids.replacement, new Date().toISOString()));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  });

  await context.test("posição e pausa serializam em conexões concorrentes", async () => {
    const concurrent = createDelivery();
    db.prepare("UPDATE deliveries SET status = 'heading_to_pickup', courier_id = ? WHERE id = ?")
      .run(ids.replacement, concurrent);
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      db.prepare("UPDATE deliveries SET status = 'awaiting_pickup' WHERE id = ?").run(workerData.id);
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      db.exec('COMMIT'); db.close(); parentPort.postMessage('done');
    `, { eval: true, workerData: { path: process.env.ERMES_DB_PATH, id: concurrent } });
    try {
      await new Promise((resolve, reject) => {
        worker.on("message", (message) => { if (message === "locked") resolve(); });
        worker.on("error", reject);
      });
      const result = await request(`/api/courier/deliveries/${concurrent}/positions`, "replacement", "POST", position());
      assert.equal(result.status, 409);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_tracking_positions WHERE delivery_id = ?")
        .get(concurrent).n, 0);
      assert.equal(db.prepare("SELECT ended_at IS NOT NULL AS closed FROM delivery_tracking_periods WHERE delivery_id = ?")
        .get(concurrent).closed, 1);
    } finally { await worker.terminate(); }
    await delay(0);
  });

  await context.test("bootstrap legado cria só o período corrente sem inventar posições", async () => {
    const legacy = createDelivery(ids.otherClient, companyB, "heading_to_pickup", ids.otherCourier);
    const again = await import(`../src/database.js?tracking-bootstrap=${Date.now()}`);
    assert.equal(again.db.prepare(`SELECT COUNT(*) AS n FROM delivery_tracking_periods WHERE delivery_id = ?`)
      .get(legacy).n, 1);
    assert.equal(again.db.prepare(`SELECT COUNT(*) AS n FROM delivery_tracking_positions WHERE delivery_id = ?`)
      .get(legacy).n, 0);
    again.db.close();
    const twice = await import(`../src/database.js?tracking-bootstrap-second=${Date.now()}`);
    assert.equal(twice.db.prepare(`SELECT COUNT(*) AS n FROM delivery_tracking_periods WHERE delivery_id = ?`)
      .get(legacy).n, 1);
    twice.db.close();
  });

  await context.test("identidade do período e vínculos da posição resistem a SQL direto", async () => {
    const protectedDelivery = createDelivery(ids.client, companyA, "heading_to_pickup", ids.courier);
    const periodId = Number(db.prepare(`INSERT INTO delivery_tracking_periods
      (delivery_id, courier_id, started_at) VALUES (?, ?, ?)`)
      .run(protectedDelivery, ids.courier, new Date().toISOString()).lastInsertRowid);
    const accepted = await request(`/api/courier/deliveries/${protectedDelivery}/positions`,
      "courier", "POST", position());
    assert.equal(accepted.status, 201);
    for (const [column, value] of [
      ["id", periodId + 1000], ["rowid", periodId + 1000],
      ["delivery_id", id], ["courier_id", ids.replacement],
      ["started_at", new Date(Date.now() - 60_000).toISOString()],
    ]) {
      assert.throws(() => db.prepare(`UPDATE delivery_tracking_periods SET ${column} = ? WHERE id = ?`)
        .run(value, periodId));
    }
    const now = new Date().toISOString();
    for (const [deliveryId, courierId] of [[id, ids.courier], [protectedDelivery, ids.replacement]]) {
      assert.throws(() => db.prepare(`INSERT INTO delivery_tracking_positions
        (delivery_id, period_id, courier_id, latitude, longitude, captured_at, received_at)
        VALUES (?, ?, ?, -23, -46, ?, ?)`).run(deliveryId, periodId, courierId, now, now));
    }
    assert.throws(() => db.prepare("DELETE FROM delivery_tracking_periods WHERE id = ?").run(periodId));
    db.prepare("UPDATE deliveries SET status = 'awaiting_pickup' WHERE id = ?").run(protectedDelivery);
    const closed = db.prepare(`SELECT delivery_id AS deliveryId, courier_id AS courierId,
      started_at AS startedAt, ended_at AS endedAt, end_kind AS endKind
      FROM delivery_tracking_periods WHERE id = ?`).get(periodId);
    assert.equal(closed.deliveryId, protectedDelivery);
    assert.equal(closed.courierId, ids.courier);
    assert.equal(closed.endKind, "paused");
    assert.ok(closed.endedAt);
    assert.throws(() => db.prepare(`UPDATE delivery_tracking_periods
      SET ended_at = NULL, end_kind = NULL WHERE id = ?`).run(periodId));
    const again = await import(`../src/database.js?tracking-protected=${Date.now()}`);
    assert.deepEqual({ ...again.db.prepare(`SELECT delivery_id AS deliveryId,
      courier_id AS courierId, started_at AS startedAt, ended_at AS endedAt,
      end_kind AS endKind FROM delivery_tracking_periods WHERE id = ?`).get(periodId) },
    { ...closed });
    assert.equal(again.db.prepare(`SELECT COUNT(*) AS n FROM delivery_tracking_positions
      WHERE period_id = ?`).get(periodId).n, 1);
    assert.deepEqual(again.db.prepare("PRAGMA foreign_key_check").all(), []);
    again.db.close();
    db.prepare("UPDATE deliveries SET status = 'cancelled', courier_id = NULL WHERE id = ?")
      .run(protectedDelivery);
  });

  await context.test("sessão expirada ou revogada durante o corpo não grava nem duplica", async () => {
    const sessionDelivery = createDelivery();
    assert.equal((await request(`/api/courier/deliveries/${sessionDelivery}/accept`,
      "courier", "POST", {})).status, 200);
    const sessionHash = hashToken("tracking-courier");
    const rows = () => db.prepare(`SELECT id, captured_at AS capturedAt,
      received_at AS receivedAt FROM delivery_tracking_positions
      WHERE delivery_id = ? ORDER BY id`).all(sessionDelivery);
    const periods = () => db.prepare(`SELECT id, started_at AS startedAt,
      ended_at AS endedAt FROM delivery_tracking_periods
      WHERE delivery_id = ? ORDER BY id`).all(sessionDelivery);
    const pendingPost = async (body) => {
      const serialized = JSON.stringify(body);
      const split = serialized.indexOf(",") + 1;
      const pending = httpRequest({ host: "127.0.0.1", port: server.address().port,
        path: `/api/courier/deliveries/${sessionDelivery}/positions`, method: "POST",
        headers: { Cookie: cookies.courier, "Content-Type": "application/json",
          "Transfer-Encoding": "chunked" } });
      const response = new Promise((resolve, reject) => {
        pending.on("response", (received) => {
          received.resume();
          received.on("end", () => resolve(received.statusCode));
        });
        pending.on("error", reject);
      });
      pending.write(serialized.slice(0, split));
      await delay(50);
      return { finish: async () => { pending.end(serialized.slice(split)); return response; } };
    };

    db.prepare("UPDATE sessions SET expires_at = datetime('now', '+2 seconds') WHERE token_hash = ?")
      .run(sessionHash);
    const beforeExpiration = { rows: rows(), periods: periods() };
    const expiring = await pendingPost(position());
    await delay(2200);
    assert.equal(db.prepare("SELECT expires_at <= CURRENT_TIMESTAMP AS expired FROM sessions WHERE token_hash = ?")
      .get(sessionHash).expired, 1);
    assert.equal(await expiring.finish(), 401);
    assert.deepEqual({ rows: rows(), periods: periods() }, beforeExpiration);

    db.prepare("UPDATE sessions SET expires_at = datetime('now', '+1 day') WHERE token_hash = ?")
      .run(sessionHash);
    const reading = position();
    assert.equal((await request(`/api/courier/deliveries/${sessionDelivery}/positions`,
      "courier", "POST", reading)).status, 201);
    const beforeRevocation = { rows: rows(), periods: periods() };
    const revoked = await pendingPost(reading);
    assert.equal((await request("/api/auth/logout", "courier", "POST")).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?")
      .get(sessionHash).n, 0);
    assert.equal(await revoked.finish(), 401);
    assert.deepEqual({ rows: rows(), periods: periods() }, beforeRevocation);
  });
});
