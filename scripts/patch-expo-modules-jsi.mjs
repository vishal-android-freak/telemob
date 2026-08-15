import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceUrl = new URL(
  '../node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI/Coding/JavaScriptCodable+Date.swift',
  import.meta.url
);
const sourcePath = fileURLToPath(sourceUrl);
const ambiguousExpression =
  'guard milliseconds.isFinite, abs(milliseconds) <= maxJavaScriptDateMilliseconds else {';
const qualifiedExpression =
  'guard milliseconds.isFinite, Swift.abs(milliseconds) <= maxJavaScriptDateMilliseconds else {';

const source = readFileSync(sourcePath, 'utf8');

if (source.includes(qualifiedExpression)) {
  process.exit(0);
}

if (!source.includes(ambiguousExpression)) {
  throw new Error(
    'expo-modules-jsi Date implementation changed; review whether the Xcode 26.2 Swift.abs patch is still required.'
  );
}

writeFileSync(sourcePath, source.replace(ambiguousExpression, qualifiedExpression));
console.log('Applied the expo-modules-jsi Xcode 26.2 Swift.abs compatibility patch.');
