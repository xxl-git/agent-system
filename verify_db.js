const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync('data/agent.db')));
  const decisions = db.exec("PRAGMA table_info(decisions)");
  console.log('decisions cols after fix:', decisions[0]?.values?.map(r => r[1]));
  db.close();
})().catch(e => console.error(e.message));
