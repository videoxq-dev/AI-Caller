import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./inspect-deployos-traefik.sh', import.meta.url).pathname;

function runPreflight(writable) {
  const directory = mkdtempSync(join(tmpdir(), 'aicaller-traefik-preflight-'));
  const dynamic = join(directory, 'generated');
  mkdirSync(dynamic);
  writeFileSync(join(dynamic, 'aicaller.yml'), 'http:\n');
  const docker = join(directory, 'docker');
  writeFileSync(docker, `#!/bin/sh
case "$1" in
  inspect)
    case "$*" in
      *'.State.Running'*) echo true ;;
      *'.Destination "/dynamic"'*) echo "$MOCK_DYNAMIC" ;;
      *'.Destination "/app/.data/traefik-domains"'*) echo "$MOCK_DYNAMIC" ;;
      *'com.docker.compose.project'*) echo aicaller ;;
      *'com.docker.compose.service'*) echo web ;;
      *'.NetworkSettings.Networks "edge"'*'.Aliases'*) echo aicaller-web ;;
      *'.NetworkSettings.Networks "edge"'*) echo yes ;;
    esac ;;
  ps)
    case "$*" in
      *'com.docker.compose.service=edge-reconciler'*) echo edge-one ;;
      *'com.docker.compose.service=web'*) echo web-one ;;
    esac ;;
  exec) test "$MOCK_WRITABLE" = 1 ;;
  *) exit 22 ;;
esac
`);
  chmodSync(docker, 0o755);
  try {
    return spawnSync('sh', [script], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        MOCK_DYNAMIC: dynamic, MOCK_WRITABLE: writable ? '1' : '0' },
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('preflight passes when the reconciler can write its shared mount', () => {
  const result = runPreflight(true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Read-only Traefik preflight complete/);
});

test('preflight rejects a correctly mounted but unwritable route directory', () => {
  const result = runPreflight(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot write its Traefik dynamic-directory mount/);
  assert.doesNotMatch(result.stdout, /Read-only Traefik preflight complete/);
});
