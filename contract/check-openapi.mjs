import assert from 'node:assert/strict';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile, NodeHost, resolveCompilerOptions } from '@typespec/compiler';

const contractDir = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(contractDir, 'openapi.yaml');

const expectedOperations = new Map([
  ['/api/v1/auth/expert/challenges', ['post']],
  ['/api/v1/auth/expert/challenges/{challengeId}/verify', ['post']],
  ['/api/v1/me', ['get']],
  ['/api/v1/me/profile', ['put']],
  ['/api/v1/auth/logout', ['post']],
  ['/api/v1/experts/{publicId}/guest-challenges', ['post']],
  ['/api/v1/experts/{publicId}/guest-challenges/{challengeId}/verify', ['post']],
  ['/api/v1/bookings/{bookingId}/access-challenges', ['post']],
  ['/api/v1/bookings/{bookingId}/access-challenges/{requestId}/verify', ['post']],
  ['/api/v1/privacy', ['get']],
  ['/api/v1/experts/{publicId}/slots', ['get']],
  ['/api/v1/me/availability', ['get', 'put']],
  ['/api/v1/me/availability/preview', ['post']],
  ['/api/v1/experts/{publicId}/bookings', ['post']],
  ['/api/v1/bookings/{bookingId}', ['get']],
  ['/api/v1/me/bookings', ['get']],
  ['/api/v1/bookings/{bookingId}/confirm', ['post']],
  ['/api/v1/bookings/{bookingId}/reject', ['post']],
  ['/api/v1/bookings/{bookingId}/withdraw', ['post']],
  ['/api/v1/bookings/{bookingId}/cancel', ['post']],
  ['/api/v1/events', ['get']],
  ['/api/v1/bookings/{bookingId}/events', ['get']],
]);

function readArtifact() {
  return readFileSync(artifactPath, 'utf8');
}

async function generate() {
  const entrypoint = join(contractDir, 'main.tsp');
  const [options, configDiagnostics] = await resolveCompilerOptions(NodeHost, {
    entrypoint,
    cwd: contractDir,
  });
  const configErrors = configDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  assert.deepEqual(configErrors, [], 'TypeSpec configuration has errors');
  const program = await compile(NodeHost, entrypoint, options);
  const compilerErrors = program.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  assert.deepEqual(compilerErrors, [], 'TypeSpec generation has errors');
}

function collectOperations(document) {
  const operations = new Map();
  let currentPath;
  for (const line of document.split(/\r?\n/u)) {
    const pathMatch = /^ {2}(\/api\/v1\/[^:]+):\s*$/u.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      operations.set(currentPath, new Set());
      continue;
    }
    if (/^ {2}\S/u.test(line)) currentPath = undefined;
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/u.exec(line);
    if (currentPath && methodMatch) operations.get(currentPath).add(methodMatch[1]);
  }
  return operations;
}

function operationSection(document, path, method) {
  const lines = document.split(/\r?\n/u);
  let currentPath;
  let start;
  for (let index = 0; index < lines.length; index += 1) {
    const pathMatch = /^ {2}(\/api\/v1\/[^:]+):\s*$/u.exec(lines[index]);
    if (pathMatch) currentPath = pathMatch[1];
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/u.exec(lines[index]);
    if (currentPath === path && methodMatch?.[1] === method) {
      start = index;
      continue;
    }
    if (start !== undefined && (/^ {2}\S/u.test(lines[index]) || methodMatch)) {
      return lines.slice(start, index).join('\n');
    }
  }
  assert.notEqual(start, undefined, `Operation not found: ${method.toUpperCase()} ${path}`);
  return lines.slice(start).join('\n');
}

function assertCsrfHeader(document, path, method, required) {
  const section = operationSection(document, path, method);
  assert.match(
    section,
    new RegExp(`^ {8}- name: X-CSRF-Token\\n {10}in: header\\n {10}required: ${required}$`, 'mu'),
    `X-CSRF-Token required=${required} missing: ${method.toUpperCase()} ${path}`,
  );
  return section;
}

const committedArtifact = readArtifact();
assert.match(committedArtifact, /^openapi:\s*["']?3\.1\.\d+["']?\s*$/mu);

const actualOperations = collectOperations(committedArtifact);
assert.deepEqual(
  [...actualOperations].map(([path, methods]) => [path, [...methods].sort()]).sort(),
  [...expectedOperations].map(([path, methods]) => [path, methods.sort()]).sort(),
  'OpenAPI operations differ from the approved public HTTP contracts',
);

for (const [path, method] of [
  ['/api/v1/me/profile', 'put'],
  ['/api/v1/auth/logout', 'post'],
  ['/api/v1/me/availability/preview', 'post'],
  ['/api/v1/me/availability', 'put'],
  ['/api/v1/bookings/{bookingId}/confirm', 'post'],
  ['/api/v1/bookings/{bookingId}/reject', 'post'],
]) {
  assertCsrfHeader(committedArtifact, path, method, true);
}

const cancelSection = assertCsrfHeader(
  committedArtifact,
  '/api/v1/bookings/{bookingId}/cancel',
  'post',
  false,
);
assert.match(cancelSection, /^ {6}description:.*cookie.*X-CSRF-Token.*$/mu);

for (const field of [
  'guestProof',
  'accessToken',
  'csrfToken',
  'consentVersion',
  'affectedBookings',
  'Idempotency-Key',
]) {
  assert.ok(committedArtifact.includes(field), `Missing public contract field: ${field}`);
}

assert.doesNotMatch(
  committedArtifact,
  /^\s+(?:EmailChallenge|ExpertSession|GuestAccess|BookingTransition|Outbox|Job|codeHash|tokenHash|hmacSecret|smtpPassword|sqliteTable):/gmu,
  'Internal storage model or secret leaked into the public contract',
);

await generate();
assert.equal(
  readArtifact(),
  committedArtifact,
  'Generated OpenAPI differs from the committed artifact',
);
await generate();
assert.equal(readArtifact(), committedArtifact, 'Repeated generation changed the OpenAPI artifact');
console.log(
  'OpenAPI 3.1 contract, public operations, exclusions, and repeatable generation verified.',
);
