-- Dashboards: each panel is a recipe, a saved query over the curated tables plus a declarative chart
-- (JSON, never code). Ogdoad ships two; the operator and the hires add the rest.

CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sql TEXT NOT NULL,
  chart TEXT NOT NULL,
  made_by TEXT NOT NULL DEFAULT 'you',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO dashboards (id, title, sql, chart, made_by, position, created_at, updated_at) VALUES (
  'builtin-money-in-out', 'Money in and out',
  'WITH RECURSIVE months(m, n) AS (
  SELECT strftime(''%Y-%m'', ''now'', ''localtime''), 0
  UNION ALL
  SELECT strftime(''%Y-%m'', date(''now'', ''localtime'', ''start of month'', ''-'' || (n + 1) || '' months'')), n + 1 FROM months WHERE n < 11
)
SELECT m AS month,
  (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = ''issued'' AND substr(issue_date, 1, 7) = m) AS invoiced,
  (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE substr(received_on, 1, 7) = m) AS received
FROM months ORDER BY month',
  '{"type":"bar","x":"month","y":["invoiced","received"],"format":"aud"}',
  'Ogdoad', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO dashboards (id, title, sql, chart, made_by, position, created_at, updated_at) VALUES (
  'builtin-hours-by-week', 'Hours worked, by week',
  'SELECT date(day, ''-6 days'', ''weekday 1'') AS week, ROUND(SUM(hours), 1) AS hours
FROM shifts
WHERE status != ''cancelled'' AND day <= date(''now'', ''localtime'') AND day > date(''now'', ''localtime'', ''-56 days'')
GROUP BY week ORDER BY week',
  '{"type":"bar","x":"week","y":["hours"],"format":"hours"}',
  'Ogdoad', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
