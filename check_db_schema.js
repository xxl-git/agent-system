const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync('data/agent.db')));
  
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('Tables:', tables.map(t => t.values));
  
  const decisions = db.exec("PRAGMA table_info(decisions)");
  console.log('decisions cols:', decisions[0]?.values?.map(r => r[1]));
  
  const summaries = db.exec("PRAGMA table_info(summaries)");
  console.log('summaries cols:', summaries[0]?.values?.map(r => r[1]));
  
  db.close();
})().catch(e => console.error(e.message));
