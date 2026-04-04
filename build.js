const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '.dist');

// Clean and create dist directory
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Copy functions directory (server-side code — Cloudflare handles this separately)
const functionsSource = path.join(__dirname, 'functions');
const functionsDest = path.join(DIST, 'functions');
if (fs.existsSync(functionsSource)) {
  copyDirSync(functionsSource, functionsDest);
}

// Minify app.js using esbuild (removes comments, whitespace, mangles variable names)
try {
  execSync(
    `npx esbuild app.js --bundle --minify --target=es2020 --outfile=.dist/app.js --legal-comments=none`,
    { stdio: 'inherit', cwd: __dirname }
  );
  console.log('✓ app.js minified');
} catch (e) {
  console.error('esbuild failed, falling back to basic copy');
  fs.copyFileSync(path.join(__dirname, 'app.js'), path.join(DIST, 'app.js'));
}

// Minify style.css using esbuild
try {
  execSync(
    `npx esbuild style.css --minify --outfile=.dist/style.css`,
    { stdio: 'inherit', cwd: __dirname }
  );
  console.log('✓ style.css minified');
} catch (e) {
  console.error('CSS minification failed, falling back to basic copy');
  fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(DIST, 'style.css'));
}

// Copy static assets
const staticFiles = ['index.html', 'megalogo.png', '_headers'];
for (const file of staticFiles) {
  const src = path.join(__dirname, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, file));
    console.log(`✓ ${file} copied`);
  }
}

// Copy vendor directory
const vendorSource = path.join(__dirname, 'vendor');
const vendorDest = path.join(DIST, 'vendor');
if (fs.existsSync(vendorSource)) {
  copyDirSync(vendorSource, vendorDest);
  console.log('✓ vendor/ copied');
}

// Copy wrangler.toml (needed for deployment)
const wranglerSrc = path.join(__dirname, 'wrangler.toml');
if (fs.existsSync(wranglerSrc)) {
  fs.copyFileSync(wranglerSrc, path.join(DIST, 'wrangler.toml'));
  console.log('✓ wrangler.toml copied');
}

// Copy D1_SCHEMA.sql
const schemaSrc = path.join(__dirname, 'D1_SCHEMA.sql');
if (fs.existsSync(schemaSrc)) {
  fs.copyFileSync(schemaSrc, path.join(DIST, 'D1_SCHEMA.sql'));
  console.log('✓ D1_SCHEMA.sql copied');
}

console.log('\n✅ Build complete! Deploy with: npx wrangler pages deploy .dist');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
