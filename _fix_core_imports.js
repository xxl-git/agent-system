const fs = require('fs');
const path = require('path');

const coreSrc = path.join(__dirname, 'packages/core/src');

// Fix logger imports in packages/core/src/**/*.ts
function fixLoggerImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  let updated = 0;
  
  for (const f of files) {
    const fullPath = path.join(dir, f.name);
    if (f.isDirectory()) {
      updated += fixLoggerImports(fullPath);
    } else if (f.name.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      // Calculate relative path to logger.ts
      const relToLogger = path.relative(path.dirname(fullPath), path.join(coreSrc, 'logger.ts'));
      const relPath = relToLogger.replace(/\\/g, '/').replace(/\.ts$/, '');
      
      // Replace incorrect ../logger or ./logger with correct relative path
      const newContent = content.replace(/from ['"](\.\./|.\/)logger['"]/g, `from '${relPath}'`);
      
      if (newContent !== content) {
        fs.writeFileSync(fullPath, newContent, 'utf8');
        updated++;
        console.log('  Fixed:', fullPath.replace(__dirname, ''));
      }
    }
  }
  return updated;
}

console.log('Fixing logger imports in packages/core/src/...');
const count = fixLoggerImports(coreSrc);
console.log(`✓ Fixed ${count} files`);

// Compile packages/core
console.log('\nCompiling packages/core...');
const { execSync } = require('child_process');
try {
  const result = execSync('node node_modules/typescript/bin/tsc -b packages/core', { encoding: 'utf8' });
  console.log(result);
  console.log('✓ Compiled successfully');
} catch(e) {
  console.log('Compile errors:');
  console.log(e.stdout || e.stderr || e.message);
}
