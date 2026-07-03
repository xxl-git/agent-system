const { execSync } = require('child_process');
const fs = require('fs');

const workDir = 'D:/QClaw_Workspace/agent-system';

try {
  // Git add
  console.log('=== Git Add ===');
  execSync('git add -A', { cwd: workDir, encoding: 'utf8' });
  console.log('✓ Added all files');
  
  // Git commit
  console.log('\n=== Git Commit ===');
  const msg = `feat: Phase 2 modularization complete - packages/server + workspace cleanup

- Create @agent-system/server package (agent-server, dashboard-api, session-store)
- Update all imports to use package paths (@agent-system/core, @agent-system/events)
- Delete duplicate directories in workspace src/ (core, config, logger, experience, memory, etc.)
- Fix TypeScript compilation errors (AgentSystemConfig.server field, initConfig export)
- Update src/index.ts (CLI entry) to use package imports
- All packages compile successfully (packages/core, packages/server, workspace)
- Server test passed (Chat API works, 4.3s response)`;
  
  execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: workDir, encoding: 'utf8' });
  console.log('✓ Committed');
  
  // Git push
  console.log('\n=== Git Push ===');
  try {
    const pushResult = execSync('git push', { cwd: workDir, encoding: 'utf8', timeout: 10000 });
    console.log(pushResult);
  } catch(e) {
    console.log('Push failed (may need manual auth):', e.message);
  }
  
} catch(e) {
  console.error('Error:', e.message);
  console.error('Stdout:', e.stdout);
  console.error('Stderr:', e.stderr);
}
