// O ciclo atual é delimitado pela coleta da tentativa mais recente.
export function cancellationEvidenceSql(stage = 'closed') {
  const closed = stage === 'closed';
  const reported = stage !== 'returning';
  return `SELECT d.id, a.id AS attemptId, a.courier_id AS courierId,
    d.returned_at AS returnedAt
    FROM deliveries d JOIN orders o ON o.id = d.order_id
    JOIN delivery_attempts a ON a.delivery_id = d.id
    JOIN delivery_events collected ON collected.delivery_id = d.id
      AND collected.event_type = 'order_collected' AND collected.occurred_at = a.started_at
      AND collected.actor_user_id = a.courier_id
    JOIN delivery_events cancelled ON cancelled.delivery_id = d.id
      AND cancelled.event_type = 'client_cancelled_after_pickup'
      AND cancelled.actor_user_id = o.client_id AND cancelled.id > collected.id
    WHERE d.status = '${closed ? 'returned' : reported ? 'awaiting_return_confirmation' : 'returning'}'
      AND d.return_reason = 'client_cancelled_after_pickup' AND o.status = 'confirmed'
      AND d.completed_at IS NULL AND d.cancelled_at IS NULL
      AND d.collected_at = a.started_at
      AND a.id = (SELECT id FROM delivery_attempts WHERE delivery_id = d.id ORDER BY attempt_number DESC LIMIT 1)
      AND collected.id = (SELECT MAX(id) FROM delivery_events WHERE delivery_id = d.id AND event_type = 'order_collected')
      AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
        AND e.event_type = 'order_collected' AND e.id > COALESCE(
          (SELECT MAX(boundary.id) FROM delivery_events boundary
            WHERE boundary.delivery_id = d.id AND boundary.event_type IN
              ('return_confirmed', 'delivery_awaiting_revalidation')
              AND boundary.id < collected.id), 0)) = 1
      AND a.status = '${closed ? 'closed_unsuccessfully' : 'returning'}'
      AND ${closed ? "a.end_reason = d.return_reason AND a.end_nature = 'terminal' AND a.ended_at = d.returned_at AND d.courier_id IS NULL" : 'a.ended_at IS NULL AND a.courier_id = d.courier_id AND d.returned_at IS NULL'}
      AND is_canonical_timestamp(a.started_at) = 1
      AND a.started_at <= cancelled.occurred_at AND cancelled.occurred_at <= CURRENT_TIMESTAMP
      AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
        AND e.event_type = 'client_cancelled_after_pickup' AND e.id > collected.id) = 1
      AND NOT EXISTS (SELECT 1 FROM delivery_occurrences oc WHERE oc.delivery_attempt_id = a.id)
      AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
        AND e.event_type = 'return_reported' AND e.id > collected.id) = ${reported ? 1 : 0}
      AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
        AND e.event_type = 'return_confirmed' AND e.id > collected.id) = ${closed ? 1 : 0}
      ${reported ? `AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
        AND e.event_type = 'return_reported' AND e.id > cancelled.id AND e.actor_user_id = a.courier_id
        AND e.occurred_at = d.return_reported_at AND e.occurred_at >= cancelled.occurred_at
        AND is_canonical_timestamp(e.occurred_at) = 1 AND e.occurred_at <= CURRENT_TIMESTAMP)` : 'AND d.return_reported_at IS NULL'}
      ${closed ? `AND EXISTS (SELECT 1 FROM delivery_events e JOIN users u ON u.id = e.actor_user_id
        WHERE e.delivery_id = d.id AND e.event_type = 'return_confirmed'
        AND e.id > (SELECT MAX(id) FROM delivery_events WHERE delivery_id = d.id AND event_type = 'return_reported')
        AND u.role = 'company' AND u.company_id = o.company_id
        AND e.occurred_at = d.returned_at AND d.returned_at >= d.return_reported_at
        AND is_canonical_timestamp(d.returned_at) = 1 AND d.returned_at <= CURRENT_TIMESTAMP
        AND json_valid(e.details_json) AND json_extract(e.details_json, '$.reason') = d.return_reason)` : ''}
  `;
}

export const CANCELLATION_CLOSED_SQL = cancellationEvidenceSql();
export function requireCancellationEvidence(db, id, stage) {
  const rows = db.prepare(`${cancellationEvidenceSql(stage)} AND d.id = ?`).all(id);
  if (rows.length !== 1) throw Object.assign(new Error('O cancelamento exige reconciliação da tentativa e do retorno.'), { statusCode: 409 });
  return rows[0];
}
