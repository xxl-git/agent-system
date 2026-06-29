$ErrorActionPreference = "SilentlyContinue"
$node = "D:\software\Common\nodejs\node.exe"
$workDir = "D:\QClaw_Workspace\agent-system"
$script = @'
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
process.chdir(path.dirname(require.main.filename));
initSqlJs().then(async (SQL) => {
  const db = new SQL.Database(new Uint8Array(fs.readFileSync('data/agent.db')));
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('Tables:', JSON.stringify(tables, null, 2));
  const cols = db.exec("PRAGMA table_info(messages)");
  console.log('messages cols:', JSON.stringify(cols, null, 2));
  const cols2 = db.exec("PRAGMA table_info(sessions)");
  console.log('sessions cols:', JSON.stringify(cols2, null, 2));
  db.close();
}).catch(e => console.error(e));
'@
$tempScript = "$env:TEMP\check_db_$PID.js"
[System.IO.File]::WriteAllText($tempScript, $script, [System.Text.UTF8Encoding]::new($true))
& $node $tempScript
Remove-Item $tempScript -Force
