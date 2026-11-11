import { DatabaseSync } from 'node:sqlite';

// Esquema mínimo y datos sintéticos con la forma medida en OpenCode 2.2.7.
export function createOpenCodeV2Fixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      revert TEXT, agent TEXT, model TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_session ON session_message(session_id, seq);
    CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT,
      call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT,
      PRIMARY KEY(message_id, ordinal));
    CREATE TABLE session_inbox (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, delivery TEXT NOT NULL,
      enqueued_seq INTEGER NOT NULL, time_created INTEGER NOT NULL);
    CREATE INDEX inbox_session ON session_inbox(session_id, enqueued_seq);
    CREATE TABLE blob (hash TEXT PRIMARY KEY, mime TEXT, bytes INTEGER, data BLOB);
    CREATE TABLE blob_ref (session_id TEXT, message_id TEXT, hash TEXT, seq INTEGER);
  `);
  const session = (id, options = {}) => db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?)').run(
    id, options.parent ?? null, options.directory ?? 'D:/test project', options.title ?? null,
    100, options.updated ?? 100, null, null, null,
  );
  const message = (id, type, seq, data, options = {}) => {
    const sessionID = options.sessionID ?? 'ses_test';
    db.prepare('INSERT OR REPLACE INTO session_message VALUES (?,?,?,?,?,?,?)').run(
      id, sessionID, type, seq, options.created ?? seq * 100, options.updated ?? seq * 100, JSON.stringify(data),
    );
    db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(options.updated ?? seq * 100, sessionID);
  };
  const inbox = (id, text, options = {}) => db.prepare('INSERT OR REPLACE INTO session_inbox VALUES (?,?,?,?,?,?,?)').run(
    id, options.sessionID ?? 'ses_test', 'user', JSON.stringify({ text }), options.delivery ?? 'queue', options.seq ?? 30, options.created ?? 3000,
  );
  session('ses_test');
  session('ses_empty');
  session('ses_child', { parent:'ses_test', title:'Subagent' });
  message('msg_user', 'user', 1, { time:{created:100}, text:'Pregunta inicial' });
  message('msg_answer', 'assistant', 2, {
    time:{created:120,completed:500}, agent:'build', model:{providerID:'fixture',id:'test-model',variant:'low'},
    content:[{type:'reasoning',text:'PRIVATE_REASONING'}, {type:'text',text:'Respuesta'}],
    finish:'stop', tokens:{input:1200,output:20,reasoning:4,cache:{read:100,write:10}},
  });
  return { db, session, message, inbox, file };
}
