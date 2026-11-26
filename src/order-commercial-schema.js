// Evidência append-only: editar incrementa a versão, sem apagar submissões antigas.
export function evolveOrderCommercialSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_submissions (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      version INTEGER NOT NULL CHECK(version > 0),
      submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(order_id, version)
    );
    CREATE TABLE IF NOT EXISTS order_rejections (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id),
      version INTEGER NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
      rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id, version) REFERENCES order_submissions(order_id, version)
    );
    CREATE TRIGGER IF NOT EXISTS order_submission_valid_insert BEFORE INSERT ON order_submissions
    WHEN NOT EXISTS (SELECT 1 FROM orders o JOIN users u ON u.id = o.client_id
      WHERE o.id = NEW.order_id AND o.status = 'draft' AND o.version = NEW.version
        AND u.role = 'client' AND u.id = NEW.submitted_by_user_id)
    BEGIN SELECT RAISE(ABORT, 'invalid order submission'); END;
    CREATE TRIGGER IF NOT EXISTS order_rejection_valid_insert BEFORE INSERT ON order_rejections
    WHEN NOT EXISTS (SELECT 1 FROM orders o JOIN users u ON u.company_id = o.company_id
      WHERE o.id = NEW.order_id AND o.company_id = NEW.company_id
        AND o.status = 'draft' AND o.version = NEW.version AND u.id = NEW.actor_user_id
        AND u.role = 'company' AND u.status = 'active'
        AND u.company_profile IN ('RESPONSAVEL', 'ATENDENTE')
        AND o.payment_status = 'pending' AND o.confirmed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM financial_entries f WHERE f.order_id = o.id))
    BEGIN SELECT RAISE(ABORT, 'invalid order rejection'); END;
    CREATE TRIGGER IF NOT EXISTS order_rejection_final BEFORE UPDATE ON orders
    WHEN OLD.status = 'rejected'
    BEGIN SELECT RAISE(ABORT, 'order rejection is final'); END;
    CREATE TRIGGER IF NOT EXISTS order_rejection_status BEFORE UPDATE OF status ON orders
    WHEN (NEW.status = 'rejected' AND NOT EXISTS
      (SELECT 1 FROM order_rejections r WHERE r.order_id = NEW.id AND r.version = NEW.version))
      OR (NEW.status <> 'rejected' AND EXISTS
      (SELECT 1 FROM order_rejections r WHERE r.order_id = NEW.id))
    BEGIN SELECT RAISE(ABORT, 'inconsistent order rejection'); END;
    CREATE TRIGGER IF NOT EXISTS rejected_order_no_delivery BEFORE INSERT ON deliveries
    WHEN EXISTS (SELECT 1 FROM order_rejections WHERE order_id = NEW.order_id)
    BEGIN SELECT RAISE(ABORT, 'rejected order cannot create delivery'); END;
    CREATE TRIGGER IF NOT EXISTS rejected_order_no_finance BEFORE INSERT ON financial_entries
    WHEN EXISTS (SELECT 1 FROM order_rejections WHERE order_id = NEW.order_id)
    BEGIN SELECT RAISE(ABORT, 'rejected order cannot create financial entries'); END;
    CREATE TRIGGER IF NOT EXISTS order_rejection_actor_identity BEFORE UPDATE OF role, company_id ON users
    WHEN EXISTS (SELECT 1 FROM order_rejections r WHERE r.actor_user_id = OLD.id
      AND (NEW.role <> 'company' OR NEW.company_id IS NOT r.company_id))
    BEGIN SELECT RAISE(ABORT, 'rejection actor identity is immutable'); END;
  `);
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS rejected_order_items_${action}
      BEFORE ${action} ON order_items WHEN EXISTS (SELECT 1 FROM order_rejections
        WHERE order_id = ${action === 'DELETE' ? 'OLD' : 'NEW'}.order_id
        ${action === 'UPDATE' ? 'OR order_id = OLD.order_id' : ''})
      BEGIN SELECT RAISE(ABORT, 'rejected order items are immutable'); END;`);
  }
  for (const table of ['order_submissions', 'order_rejections']) {
    for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS
      ${table}_immutable_${action} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'commercial evidence is immutable'); END;`);
  }
}

export function commercialEvidence(db, orderId) {
  const submission = db.prepare(`SELECT s.version, s.submitted_at AS submittedAt
    FROM order_submissions s JOIN orders o ON o.id = s.order_id AND o.version = s.version
    WHERE s.order_id = ?`).get(orderId);
  const rejection = db.prepare(`SELECT reason, actor_user_id AS actorUserId,
    company_id AS companyId, rejected_at AS rejectedAt, version
    FROM order_rejections WHERE order_id = ?`).get(orderId);
  return { submittedAt: submission?.submittedAt ?? null,
    submittedVersion: submission?.version ?? null, rejection: rejection ?? null };
}
