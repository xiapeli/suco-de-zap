import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIngestionSpool, type StagedMessage } from '../src/lib/ingestion-spool.js';

const message: StagedMessage = {
  chat_jid: 'private-chat@example.invalid',
  id: 'private-message-id',
  sender_jid: 'private-sender@example.invalid',
  sender_name: 'Private Synthetic Name',
  from_me: false,
  body: 'PRIVATE_SYNTHETIC_BODY_DO_NOT_EXPOSE',
  msg_type: 'text',
  ts: new Date('2026-10-23T08:00:00.000Z'),
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'suco-spool-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, key: randomBytes(32), tenantId: 'synthetic-tenant' };
}

test('encrypted stage survives two restarts and ack occurs only after idempotent commit', async (t) => {
  const args = await fixture(t);
  const first = await createIngestionSpool(args);
  await first.stage(message);
  await first.stage(message); // Duplicate delivery must not replace the staged record.
  first.close();

  const files = await readdir(args.directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.msg$/);
  const disk = await readFile(join(args.directory, files[0]));
  assert.equal(disk.includes(Buffer.from(message.body!)), false);
  assert.equal(disk.includes(Buffer.from(message.chat_jid)), false);

  const committed = new Set<string>();
  const second = await createIngestionSpool(args);
  const beforeCrash = [];
  for await (const pending of second.pending()) {
    beforeCrash.push(pending);
    committed.add(`${pending.chat_jid}/${pending.id}`); // Simulated DB commit.
  }
  assert.equal(beforeCrash.length, 1);
  assert.deepEqual(beforeCrash[0], message);
  second.close(); // Crash after DB commit, before spool ack.

  const third = await createIngestionSpool(args);
  let replays = 0;
  for await (const pending of third.pending()) {
    replays++;
    committed.add(`${pending.chat_jid}/${pending.id}`); // ON CONFLICT does nothing.
    await third.ack(pending.chat_jid, pending.id);
  }
  assert.equal(replays, 1);
  assert.equal(committed.size, 1);
  assert.equal((await readdir(args.directory)).length, 0);
  const remaining = [];
  for await (const pending of third.pending()) remaining.push(pending);
  assert.deepEqual(remaining, []);
  await third.ack(message.chat_jid, message.id); // Ack itself is idempotent.
  third.close();
});

test('an interrupted stage with a complete temporary record is recovered before replay', async (t) => {
  const args = await fixture(t);
  const first = await createIngestionSpool(args);
  await first.stage(message);
  first.close();
  const [final] = await readdir(args.directory);
  const hash = final.slice(0, 64);
  await copyFile(join(args.directory, final), join(args.directory, `.${hash}.0123456789abcdef.tmp`));
  await unlink(join(args.directory, final));

  const second = await createIngestionSpool(args);
  const replay = [];
  for await (const pending of second.pending()) replay.push(pending);
  assert.deepEqual(replay, [message]);
  assert.deepEqual(await readdir(args.directory), [final]);
  second.close();
});

test('wrong key, wrong tenant and corrupted ciphertext fail closed without plaintext in errors', async (t) => {
  const args = await fixture(t);
  const first = await createIngestionSpool(args);
  await first.stage(message);
  first.close();

  for (const change of [{ key: randomBytes(32) }, { tenantId: 'another-tenant' }]) {
    const wrong = await createIngestionSpool({ ...args, ...change });
    await assert.rejects(async () => {
      for await (const _ of wrong.pending()) { /* consume */ }
    }, { code: 'INGESTION_SPOOL_UNREADABLE' });
    wrong.close();
  }

  const [final] = await readdir(args.directory);
  const file = join(args.directory, final);
  const ciphertext = await readFile(file);
  ciphertext[ciphertext.length - 1] ^= 1;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, ciphertext, { mode: 0o600 });
  const tampered = await createIngestionSpool(args);
  await assert.rejects(async () => {
    for await (const _ of tampered.pending()) { /* consume */ }
  }, (error: unknown) => {
    const candidate = error as Error & { code?: string };
    assert.equal(candidate.code, 'INGESTION_SPOOL_UNREADABLE');
    assert.doesNotMatch(candidate.message, /PRIVATE_SYNTHETIC|private-chat/);
    return true;
  });
  tampered.close();
});

test('requires a private directory and a supplied 32-byte runtime key', async (t) => {
  const args = await fixture(t);
  await assert.rejects(createIngestionSpool({ ...args, key: randomBytes(16) }), {
    code: 'INGESTION_SPOOL_INPUT',
  });
  await chmod(args.directory, 0o755);
  await assert.rejects(createIngestionSpool(args), { code: 'INGESTION_SPOOL_UNSAFE' });
});
