const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

function copyFolderSync(from, to) {
  if (!fs.existsSync(from)) return;
  if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    const stat = fs.lstatSync(path.join(from, element));
    if (stat.isFile()) {
      fs.copyFileSync(path.join(from, element), path.join(to, element));
    } else if (stat.isDirectory()) {
      copyFolderSync(path.join(from, element), path.join(to, element));
    }
  });
}

function copyFileSync(from, to) {
  if (!fs.existsSync(from)) return;
  const parent = path.dirname(to);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.copyFileSync(from, to);
}

console.log('📦 Synchronizing public directory for Vercel deployment...');

// 1. Assets
copyFolderSync(path.join(rootDir, 'assets'), path.join(publicDir, 'assets'));
console.log('✅ assets synced to public/assets');

// 2. JS
copyFolderSync(path.join(rootDir, 'js'), path.join(publicDir, 'js'));
console.log('✅ js synced to public/js');

// 3. HTML pages
['index.html', 'admin.html', 'pay.html', '404.html'].forEach(file => {
  copyFileSync(path.join(rootDir, file), path.join(publicDir, file));
});
console.log('✅ HTML files synced to public/');

// 4. Standalone icons & SEO
['robots.txt', 'sitemap.xml'].forEach(file => {
  copyFileSync(path.join(rootDir, file), path.join(publicDir, file));
});
if (fs.existsSync(path.join(rootDir, 'assets', 'favicon.svg'))) {
  copyFileSync(path.join(rootDir, 'assets', 'favicon.svg'), path.join(publicDir, 'favicon.svg'));
}

console.log('🎉 Public directory synchronization complete!');
