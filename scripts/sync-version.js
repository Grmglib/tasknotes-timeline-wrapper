'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'manifest.json');
const versionsPath = path.join(root, 'versions.json');
const checkOnly = process.argv.includes('--check');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const packageJson = readJson(packagePath);
const manifest = readJson(manifestPath);
const versions = readJson(versionsPath);
const version = packageJson.version;
const minAppVersion = manifest.minAppVersion;

const problems = [];
if (manifest.version !== version) {
  problems.push(`manifest.json is ${manifest.version}; package.json is ${version}`);
}
if (versions[version] !== minAppVersion) {
  problems.push(`versions.json is missing ${version}: ${minAppVersion}`);
}

if (checkOnly) {
  if (problems.length) {
    console.error(`Version metadata is out of sync:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  }
  return;
}

manifest.version = version;
versions[version] = minAppVersion;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
console.log(`Synchronized release metadata for ${version}.`);
