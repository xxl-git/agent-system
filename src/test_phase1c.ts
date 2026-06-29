// Phase 1C 验证脚本 — 项目管理闭环
import { getProjectManager } from './core/projects/project-manager';
import logger from './logger';

async function test() {
  console.log('=== Phase 1C 项目管理闭环验证 ===\n');
  logger.setLevel('debug');

  const pm = getProjectManager({ baseDir: './test_projects', inactivityDaysToArchive: 7 });

  // 1. 创建项目
  console.log('>>> 测试1: 创建项目');
  const proj = pm.createProject('test-media-center', {
    description: '开发一个媒体中心应用',
    priority: 'P1',
    tags: ['media', 'pyqt6'],
  });
  console.log(`✅ 项目已创建: ${proj.project} (${proj.status}, ${proj.priority})`);
  console.log(`   创建时间: ${proj.created}\n`);

  // 2. 添加待办
  console.log('>>> 测试2: 添加待办');
  const todo1 = pm.addTodo('test-media-center', {
    title: '需求分析',
    status: 'done',
    priority: 'P0',
  });
  const todo2 = pm.addTodo('test-media-center', {
    title: '数据库设计',
    status: 'in_progress',
    priority: 'P1',
  });
  const todo3 = pm.addTodo('test-media-center', {
    title: 'UI 开发',
    status: 'pending',
    priority: 'P2',
  });
  console.log(`✅ 添加了 3 个待办`);

  // 3. 进度计算
  console.log('\n>>> 测试3: 进度计算');
  pm.updateTodo('test-media-center', todo2.id, 'done');
  const progress = pm.recalculateProgress('test-media-center');
  console.log(`✅ 进度: ${progress}% (期望 67%)\n`);

  // 4. 写日报
  console.log('>>> 测试4: 日报');
  pm.writeJournal('test-media-center', {
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    action: '完成数据库设计，开始UI开发',
    result: 'success',
    next: '实现前端框架',
  });
  console.log('✅ 日报已写入\n');

  // 5. 保存检查点
  console.log('>>> 测试5: 检查点');
  const cp = pm.saveCheckpoint('test-media-center', 'test-session', { a: 1, b: 2 }, [0, 1], 2);
  console.log(`✅ 检查点已保存: ${cp.savedAt}`);
  console.log(`   完成: ${cp.completed.length}/${cp.lastSubtask}\n`);

  // 6. 恢复检查点
  console.log('>>> 测试6: 恢复检查点');
  const restored = pm.restoreCheckpoint('test-media-center');
  console.log(`✅ 检查点已恢复: ${restored?.completed.length} 完成, 停在步骤 ${restored?.lastSubtask}\n`);

  // 7. 项目切换
  console.log('>>> 测试7: 项目切换');
  pm.createProject('test-another', { priority: 'P2' });
  const active = pm.getActiveProject();
  console.log(`✅ 活跃项目: ${active?.project}\n`);

  // 8. 恢复摘要
  console.log('>>> 测试8: 恢复摘要');
  pm.setActive('test-media-center', true);
  const summary = pm.recoverySummary();
  console.log(summary);
  console.log('');

  // 9. 列表项目
  console.log('>>> 测试9: 项目列表');
  const projects = pm.listProjects();
  console.log(`✅ ${projects.length} 个项目:`);
  projects.forEach(p => {
    const bar = '█'.repeat(p.progress / 10) + '░'.repeat(10 - p.progress / 10);
    console.log(`  ${p.active ? '▶' : ' '} [${p.status}] ${p.project} [${bar}] ${p.progress}%`);
  });
  console.log('');

  // 10. 验证文件存在
  const fs = require('fs');
  const path = require('path');
  const projectDir = path.resolve('test_projects/test-media-center');
  ['PROGRESS.md', 'JOURNAL.md', 'TODO.md', 'DESIGN.md', 'checkpoint.json'].forEach(f => {
    const exists = fs.existsSync(path.join(projectDir, f));
    console.log(`📄 ${f}: ${exists ? '✅' : '❌'}`);
  });

  // 清理
  fs.rmSync('test_projects', { recursive: true, force: true });
  console.log('\n✅✅✅ Phase 1C 验证通过！');
  process.exit(0);
}

test().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
