/** Consultas de OpenCode 2.2.7. Solo campos visibles y siempre por sesión o mensaje. */
const toolText = `(SELECT group_concat(json_extract(tc.value, '$.text'), char(10))
  FROM json_each(c.value, '$.state.content') tc WHERE json_extract(tc.value, '$.type') = 'text')`;
const contentParts = `WITH selected AS (
  SELECT id, session_id, type, seq, time_created, time_updated, data
  FROM session_message WHERE session_id = $s AND id IN (SELECT value FROM json_each($ids))
), assistant_content AS (
  SELECT m.id AS message_id, c.key, c.value
  FROM selected m, json_each(m.data, '$.content') c
  WHERE m.type = 'assistant' AND NOT EXISTS (
    SELECT 1 FROM session_part p WHERE p.session_id = $s AND p.message_id = m.id
      AND p.ordinal = CAST(c.key AS INTEGER)
  )
  UNION ALL
  SELECT p.message_id, p.ordinal AS key, p.data AS value
  FROM selected m JOIN session_part p ON p.message_id = m.id AND p.session_id = $s
  WHERE m.type = 'assistant'
)
SELECT m.id AS message_id, m.seq, 0 AS ordinal, m.id || ':text' AS id,
  coalesce(json_extract(m.data, '$.time.created'), m.time_created) AS at, 'text' AS type,
  substr(json_extract(m.data, '$.text'), 1, $textCut) AS text,
  length(json_extract(m.data, '$.text')) AS text_length,
  NULL AS tool, NULL AS status, NULL AS input_json, NULL AS input_length,
  NULL AS output, NULL AS output_length, NULL AS error, NULL AS error_length,
  NULL AS attachment_count, NULL AS mime, NULL AS auto, NULL AS answers_json
FROM selected m WHERE m.type = 'user'
UNION ALL
SELECT m.id, m.seq, CAST(c.key AS INTEGER) + 1,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN json_extract(c.value, '$.id')
    ELSE m.id || ':content:' || printf('%08d', c.key) END,
  coalesce(json_extract(c.value, '$.time.created'), json_extract(m.data, '$.time.created'), m.time_created),
  json_extract(c.value, '$.type'),
  CASE WHEN json_extract(c.value, '$.type') = 'text' THEN substr(json_extract(c.value, '$.text'), 1, $textCut) END,
  CASE WHEN json_extract(c.value, '$.type') = 'text' THEN length(json_extract(c.value, '$.text')) END,
  json_extract(c.value, '$.name'),
  CASE json_extract(c.value, '$.state.status') WHEN 'streaming' THEN 'pending' ELSE json_extract(c.value, '$.state.status') END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN substr(json_extract(c.value, '$.state.input'), 1, $inputCut) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN length(json_extract(c.value, '$.state.input')) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN substr(${toolText}, 1, $outputCut) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN length(${toolText}) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN substr(json_extract(c.value, '$.state.error.message'), 1, $outputCut) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN length(json_extract(c.value, '$.state.error.message')) END,
  CASE WHEN json_extract(c.value, '$.type') = 'tool' THEN
    (SELECT count(*) FROM json_each(c.value, '$.state.content') attachment WHERE json_extract(attachment.value, '$.type') = 'file') END,
  NULL, NULL,
  CASE WHEN json_extract(c.value, '$.name') = 'question' THEN json_extract(c.value, '$.state.metadata.answers') END
FROM selected m JOIN assistant_content c ON c.message_id = m.id
WHERE m.type = 'assistant' AND json_extract(c.value, '$.type') IN ('text', 'tool')
UNION ALL
SELECT m.id, m.seq, CAST(f.key AS INTEGER) + 1, m.id || ':file:' || printf('%08d', f.key),
  m.time_created, 'file', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  json_extract(f.value, '$.mime'), NULL, NULL
FROM selected m, json_each(m.data, '$.files') f WHERE m.type = 'user'
UNION ALL
SELECT m.id, m.seq, 0, m.id || ':compaction', m.time_created,
  'compaction', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  CASE WHEN json_extract(m.data, '$.reason') = 'auto' THEN 1 ELSE 0 END, NULL
FROM selected m WHERE m.type = 'compaction' AND json_extract(m.data, '$.status') = 'completed'
ORDER BY seq, ordinal`;

export const OPENCODE_V2_SQL = Object.freeze({
  listRoots: `SELECT id, directory, coalesce(title, '') AS title, time_created, time_updated
FROM session_v2 WHERE parent_id IS NULL ORDER BY time_created, id`,
  rootStamps: `SELECT id, time_updated FROM session_v2 WHERE parent_id IS NULL`,
  sessionById: `SELECT id, parent_id, directory, coalesce(title, '') AS title, time_created, time_updated, revert
FROM session_v2 WHERE id = ?`,
  sessionExists: `SELECT 1 AS found FROM session_v2 WHERE id = ?`,
  sessionParentById: `SELECT parent_id FROM session_v2 WHERE id = ?`,
  sessionHasMessages: `SELECT 1 AS found FROM session_message
WHERE session_id = ? AND type IN ('user', 'assistant') LIMIT 1`,
  firstUserText: `SELECT substr(json_extract(data, '$.text'), 1, 400) AS text
FROM session_message WHERE session_id = ? AND type = 'user'
  AND length(trim(json_extract(data, '$.text'))) > 0 ORDER BY seq, id LIMIT 1`,
  signature: `SELECT
  (SELECT count(*) FROM session_message WHERE session_id = $s) AS message_count,
  (SELECT coalesce(max(time_updated), 0) FROM session_message WHERE session_id = $s) AS message_max,
  (SELECT coalesce(max(seq), 0) FROM session_message WHERE session_id = $s) AS message_seq,
  (SELECT count(*) FROM session_part WHERE session_id = $s) AS part_count,
  (SELECT coalesce(max(time_updated), 0) FROM session_part WHERE session_id = $s) AS part_max,
  (SELECT count(*) FROM session_inbox WHERE session_id = $s) AS inbox_count,
  (SELECT coalesce(max(enqueued_seq), 0) FROM session_inbox WHERE session_id = $s) AS inbox_seq,
  (SELECT group_concat(id || ':' || delivery) FROM session_inbox WHERE session_id = $s) AS inbox_delivery`,
  messages: `SELECT id, type, seq, time_created, time_updated,
  CASE WHEN type = 'compaction' THEN json_extract(data, '$.status') END AS compaction_status,
  coalesce(json_extract(data, '$.time.created'), time_created) AS created_at,
  json_extract(data, '$.time.completed') AS completed_at,
  json_extract(data, '$.model.providerID') AS provider_id,
  json_extract(data, '$.model.id') AS model_id,
  json_extract(data, '$.model.variant') AS variant,
  json_extract(data, '$.finish') AS finish,
  json_extract(data, '$.tokens.input') AS t_input,
  json_extract(data, '$.tokens.output') AS t_output,
  json_extract(data, '$.tokens.reasoning') AS t_reasoning,
  json_extract(data, '$.tokens.cache.read') AS t_cache_read,
  json_extract(data, '$.tokens.cache.write') AS t_cache_write,
  CASE json_extract(data, '$.error.type') WHEN 'aborted' THEN 'MessageAbortedError'
    ELSE json_extract(data, '$.error.type') END AS error_name,
  substr(json_extract(data, '$.error.message'), 1, 300) AS error_message
FROM session_message WHERE session_id = $s AND (time_updated >= $since OR seq > $seq
  OR EXISTS (SELECT 1 FROM session_part p WHERE p.session_id = $s
    AND p.message_id = session_message.id AND p.time_updated >= $since))
ORDER BY seq, id`,
  parts: contentParts,
  inbox: `SELECT id, time_created, delivery, enqueued_seq,
  substr(json_extract(payload, '$.text'), 1, $textCut) AS text,
  length(json_extract(payload, '$.text')) AS text_length,
  (SELECT count(*) FROM json_each(payload, '$.files') file WHERE json_extract(file.value, '$.mime') LIKE 'image/%') AS images
FROM session_inbox WHERE session_id = $s AND type = 'user' ORDER BY enqueued_seq, id`,
  image: `SELECT json_extract(file.value, '$.mime') AS mime,
  CASE WHEN length(json_extract(file.value, '$.data')) <= $max THEN json_extract(file.value, '$.data') END AS data
FROM session_message message, json_each(message.data, '$.files') file
WHERE message.session_id = $s AND message.id = $id AND message.type = 'user'
  AND json_extract(file.value, '$.mime') LIKE 'image/%' ORDER BY CAST(file.key AS INTEGER) LIMIT 1 OFFSET $index`,
  partCallById: `SELECT message.id AS message_id, json_extract(content.value, '$.id') AS call_id
FROM session_message message, json_each(message.data, '$.content') content
WHERE message.session_id = $s AND message.type = 'assistant'
  AND json_extract(content.value, '$.type') = 'tool'
  AND json_extract(content.value, '$.id') = $id
  AND json_extract(content.value, '$.name') = 'question'
UNION ALL
SELECT p.message_id, p.call_id FROM session_part p
WHERE p.session_id = $s AND p.call_id = $id AND p.type = 'tool'
  AND json_extract(p.data, '$.name') = 'question' LIMIT 1`,
  lastChoice: `SELECT agent, json_extract(model, '$.providerID') AS provider_id,
  json_extract(model, '$.id') AS model_id, json_extract(model, '$.variant') AS variant
FROM session_v2 WHERE id = $s`,
});

export const OPENCODE_V2_REQUIRED_COLUMNS = Object.freeze([
  { table:'session_v2', columns:['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'revert', 'agent', 'model'] },
  { table:'session_message', columns:['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'] },
  { table:'session_part', columns:['message_id', 'session_id', 'ordinal', 'type', 'call_id', 'time_created', 'time_updated', 'data'] },
  { table:'session_inbox', columns:['id', 'session_id', 'type', 'payload', 'delivery', 'enqueued_seq', 'time_created'] },
] as const);
