const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync('data/agent.db')));
  
  // Check decisions schema
  const decisions = db.exec("PRAGMA table_info(decisions)");
  console.log('decisions cols:', decisions[0]?.values?.map(r => r[1]));
  
  // Try ALTER TABLE
  try {
    db.run("ALTER TABLE decisions ADD COLUMN session_id TEXT DEFAULT ''");
    console.log('ALTER TABLE decisions: OK');
    fs.writeFileSync('data/agent.db', db.export());
    console.log('DB saved');
  } catch(e) {
    console.error('ALTER TABLE failed:', e.message);
  }
  
  db.close();
})().catch(e => console.error(e.message));
