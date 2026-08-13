#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tag = process.argv[2] ?? '';
const shouldWrite = process.argv.includes('--write');
const match = /^v(1\.\d+\.\d+)(-beta\.\d+)?$/.exec(tag);

if (!match) {
  console.error(
    `Unsupported release tag "${tag}". Use v1.X.Y or v1.X.Y-beta.N.`
  );
  process.exit(2);
}

const version = match[1];
const npmVersion = tag.slice(1);
const prerelease = Boolean(match[2]);
const profile = prerelease ? 'beta' : 'production';
const root = resolve(import.meta.dirname, '..');

if (shouldWrite) {
  updateJson(resolve(root, 'app.json'), value => {
    value.expo.version = version;
  });
  updateJson(resolve(root, 'package.json'), value => {
    value.version = npmVersion;
  });
  updateJson(resolve(root, 'package-lock.json'), value => {
    value.version = npmVersion;
    if (value.packages?.['']) value.packages[''].version = npmVersion;
  });
}

const metadata = { tag, version, npmVersion, prerelease, profile };

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `tag=${tag}`,
      `version=${version}`,
      `npm_version=${npmVersion}`,
      `prerelease=${prerelease}`,
      `profile=${profile}`,
      '',
    ].join('\n')
  );
}

console.log(JSON.stringify(metadata));

function updateJson(path, update) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
