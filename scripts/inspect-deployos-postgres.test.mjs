import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./inspect-deployos-postgres.sh', import.meta.url).pathname;

function withDockerMock(testCase, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aicaller-db-inventory-'));
  const dockerPath = join(directory, 'docker');
  writeFileSync(dockerPath, [
    '#!/bin/sh',
    'case "$1" in',
    '  ps) printf "%s\\n" "${MOCK_MATCHES:-db-one}" ;;',
    '  inspect)',
    '    case "$3" in',
    '      *com.docker.compose.project*) printf "%s\\n" "${MOCK_PROJECT:-ai-caller}" ;;',
    '      *com.docker.compose.service*) echo postgres ;;',
    '      *var/lib/postgresql/data*) echo ai-caller_postgres_data ;;',
    '      *) exit 22 ;;',
    '    esac ;;',
    '  port) exit "${MOCK_PUBLISHED:-1}" ;;',
    '  exec)',
    '    echo "hba_host_non_scram=2"',
    '    echo "workspaces=3"',
    '    echo "credit_ledger=5"',
    '    ;;',
    '  *) exit 23 ;;',
    'esac',
  ].join('\n'));
  chmodSync(dockerPath, 0o755);
  try {
    const run = spawnSync('sh', [script], {
      env: { ...process.env, PATH: [directory, process.env.PATH].join(':'), ...config },
      encoding: 'utf8',
    });
    testCase(run);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('summarizes the selected persisted database without exposing records', () => {
  withDockerMock(({ status, stdout, stderr }) => {
    assert.equal(status, 0, stderr);
    assert.match(stdout, /postgres_data_volume=ai-caller_postgres_data/);
    assert.match(stdout, /postgres_host_port_published=no/);
    assert.match(stdout, /hba_host_non_scram=2/);
    assert.match(stdout, /credit_ledger=5/);
    assert.match(stdout, /No backup, migration, password rotation or restart performed/);
  });
});

test('does not guess when more than one database container is found', () => {
  withDockerMock(({ status, stderr }) => {
    assert.notEqual(status, 0);
    assert.match(stderr, /Expected one running AI Caller PostgreSQL container/);
  }, { MOCK_MATCHES: 'db-one\ndb-two' });
});

test('refuses a different Compose project even when container explicitly selected', () => {
  withDockerMock(({ status, stderr }) => {
    assert.notEqual(status, 0);
    assert.match(stderr, /outside the existing ai-caller\/postgres/);
  }, { MOCK_PROJECT: 'unrelated', AI_CALLER_DB_CONTAINER: 'db-one' });
});

test('flags a published database port without printing sensitive configuration', () => {
  withDockerMock(({ status, stdout }) => {
    assert.equal(status, 0);
    assert.match(stdout, /postgres_host_port_published=yes/);
  }, { MOCK_PUBLISHED: '0' });
});
