/* Close out the orphaned late-reveal-vote election (segment 1).
 *
 * The previous late_reveal.mjs run created the election and committed
 * one vote, then was killed by a runtime restart while waiting for
 * the reveal hour. The salt and the temp-account keys died with that
 * process, so the commitment can never be revealed. The election is
 * OPEN with no funds involved; anyone may finalize it. This script
 * uses a fresh throwaway account to finalize it (-> NO_VOTES [0,0]),
 * reads back the terminal state, and appends the finalize transaction
 * and the election record (with the final readback) to the journal.
 * Keys exist only in process memory, never on disk.
 *
 * The `created` snapshot stored in the journal is reconstructed from
 * the pre-finalize readback with commitments emptied: at creation
 * time the election had no commitments. Deadlines/options/owner are
 * read from the chain, not assumed.
 */
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { assertSuccessfulConsensus } from './receipt.mjs';

const root = new URL('../', import.meta.url);
const journalFile = new URL('evidence/live.json', root);
const checkpointFile = new URL('LATE_REVEAL_CHECKPOINT.json', root);
const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
const ADDRESS = '0xF68b58AEA5AE127b34917D49e9F830F51FEFB9C0';
assert.equal(journal.contract_address, ADDRESS, 'contract mismatch');
const ELECTION_ID = 'late-reveal-vote';
const CREATOR = journal.accounts.lateCreator;
assert.equal(checkpoint.election_id, ELECTION_ID, 'checkpoint mismatch');
assert.equal(checkpoint.txs.create,
  '0xffe2da38edfc56e067ccee62133f5d7fb0e3e2537bcc49bf9f09c311cc32977a',
  'checkpoint create hash mismatch');
assert.equal(checkpoint.txs.commit,
  '0x335435a435e50037cea31128254289ab651313662199030c6af948047555a652',
  'checkpoint commit hash mismatch');
// The two on-chain txs must already be in the journal exactly once.
for (const hash of Object.values(checkpoint.txs)) {
  const hits = journal.transactions.filter((t) => t.hash === hash);
  assert.equal(hits.length, 1, 'journal must hold tx once: ' + hash);
}
assert.equal(journal.transactions.filter(
  (t) => t.label === `${ELECTION_ID}:finalize`).length, 0,
  'finalize already recorded — refusing to resubmit');
assert.equal(journal.elections.some((e) => e.id === ELECTION_ID), false,
  'election already recorded — refusing to duplicate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function save() {
  fs.writeFileSync(journalFile, JSON.stringify(journal,
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
}
function saveCheckpoint(extra = {}) {
  checkpoint.updated_at = new Date().toISOString();
  Object.assign(checkpoint, extra);
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2) + '\n');
}

async function rpc(method, params = [], attempts = 6) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(journal.network.rpc, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw Error('RPC ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (String(e).startsWith('RPC ')) throw e;
      if (i === attempts - 1) throw e;
      console.log('rpc retry', method, String(e).slice(0, 100));
      await sleep(delay);
      delay *= 2;
    }
  }
}

const finalizer = createAccount();
const client = createClient({ chain: studionet, account: finalizer });
journal.accounts.lateFinalizer = finalizer.address;
save();

const read = async (fn, args = []) => {
  for (let i = 0; i < 6; i++) {
    try {
      return await client.readContract({ address: ADDRESS,
        functionName: fn, args, transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      console.log('read retry', fn, String(e).slice(0, 100));
      await sleep(2000 * (i + 1));
    }
  }
};
const getElection = async () =>
  JSON.parse(await read('get_election', [CREATOR, ELECTION_ID]) || 'null');

async function pollReceipt(hash, label) {
  for (let i = 0; i < 240; i++) {
    let receipt = null;
    try {
      receipt = await rpc('eth_getTransactionByHash', [hash]);
    } catch (e) {
      console.log(label, 'poll rpc error, retrying:', String(e).slice(0, 100));
      await sleep(5000);
      continue;
    }
    if (receipt?.status === 'FINALIZED') return receipt;
    if (['UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT']
      .includes(receipt?.status)) throw Error(label + ' stopped: ' + receipt.status);
    if (i % 12 === 0) console.log(label, 'polling', receipt?.status);
    await sleep(5000);
  }
  throw Error(label + ' pending; retain hash and inspect without resubmission');
}

try {
  if (BigInt(await rpc('eth_chainId')) !== 61999n) throw Error('WRONG_CHAIN');
  if (BigInt(await rpc('eth_gasPrice')) !== 0n)
    throw Error('NONZERO_GAS_PRICE: no paid transaction allowed');
  const code = fs.readFileSync(new URL('contracts/sealed_vote.py', root), 'utf8');
  if (sha(code) !== journal.source_sha256) throw Error('SOURCE_CHANGED_SINCE_DEPLOY');
  const deployed = await client.getContractCode(ADDRESS);
  if (deployed !== code) throw Error('DEPLOYED_SOURCE_MISMATCH');
  if (await read('get_protocol') !== 'sealed-vote-1') throw Error('PROTOCOL_MISMATCH');

  const before = await getElection();
  console.log('pre-finalize readback:', JSON.stringify({
    state: before.state, commitments: Object.keys(before.commitments).length,
    revealed_count: before.revealed_count, result: before.result,
    commit_deadline: before.commit_deadline,
    reveal_deadline: before.reveal_deadline }));
  assert.equal(before.state, 'OPEN');
  assert.equal(Object.keys(before.commitments).length, 1);
  assert.equal(before.revealed_count, 0);
  assert.equal(before.result, null);
  assert.equal(before.commit_deadline, '2026-11-10T01:00:00Z');
  assert.equal(before.reveal_deadline, '2026-11-10T02:00:00Z');
  // Reconstructed post-create snapshot (no commitments yet at creation).
  const created = { ...before, commitments: {}, revealed_count: 0 };

  const label = `${ELECTION_ID}:finalize`;
  const entry = { label, sender: finalizer.address, expected: 'success',
    submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); save();
  try {
    entry.hash = await client.writeContract({ address: ADDRESS,
      functionName: 'finalize_tally', args: [CREATOR, ELECTION_ID], value: 0n,
      leaderOnly: false, consensusMaxRotations: 0 });
    save();
    console.log(label, 'SUBMITTED', entry.hash);
  } catch (e) {
    entry.error = String(e); save();
    throw Error(label + ' submission uncertain: ' + String(e));
  }
  entry.receipt = await pollReceipt(entry.hash, label);
  save();
  const votes = assertSuccessfulConsensus(entry.receipt);
  console.log(label, 'VERIFIED', votes.agree + '/' + votes.total + ' AGREE');

  const finalEl = await getElection();
  assert.equal(finalEl.state, 'TALLIED');
  assert.equal(finalEl.result.outcome, 'NO_VOTES');
  assert.deepEqual(finalEl.result.counts, [0, 0]);
  assert.equal(finalEl.result.total_revealed, 0);
  assert.equal(finalEl.result.winner, null);
  journal.elections.push({ id: ELECTION_ID, case: 'late-reveal',
    created, final: finalEl, creator: CREATOR });
  save();
  checkpoint.txs.finalize = entry.hash;
  saveCheckpoint({ stage: 'finalized-orphan', final_state: 'TALLIED',
    outcome: 'NO_VOTES', counts: [0, 0] });
  console.log('ORPHAN_FINALIZE_COMPLETE', JSON.stringify({
    finalize: entry.hash, final: { state: 'TALLIED',
      outcome: 'NO_VOTES', counts: [0, 0] } }, null, 2));
} catch (e) {
  try { save(); } catch {}
  console.error('ORPHAN_FINALIZE_FAILED', String(e));
  process.exitCode = 1;
}
