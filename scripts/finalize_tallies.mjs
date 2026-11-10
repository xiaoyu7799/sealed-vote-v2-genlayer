/* Finalize step for a staged live run (scripts/live.mjs).
 *
 * finalize_tally is callable by anyone, because the tally is a pure
 * function of the revealed ballots and the caller cannot change the
 * outcome. This script uses a fresh throwaway account to finalize
 * elections whose reveal windows have closed, reads back every
 * election, and completes the journal (evidence/live.json). The
 * journal's earlier transactions are untouched; the finalize entries
 * and the final readbacks are appended, with the new account recorded
 * as `finalizer`. Keys exist only in process memory, never on disk.
 */
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { assertSuccessfulConsensus } from './receipt.mjs';

const root = new URL('../', import.meta.url);
const journalFile = new URL('evidence/live.json', root);
const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
const RPC = journal.network.rpc;
const address = journal.contract_address;
const creator = journal.accounts.creator;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params = [], attempts = 6) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw Error('RPC ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (String(e).startsWith('RPC ')) throw e;
      if (i === attempts - 1) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}
async function utcNow() {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=UTC');
      return new Date((await r.json()).dateTime + 'Z');
    } catch (e) {
      if (i === 5) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

const finalizer = createAccount();
const client = createClient({ chain: studionet, account: finalizer });
journal.accounts.finalizer = finalizer.address;
fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\n');

const read = async (fn, args = []) => {
  for (let i = 0; i < 6; i++) {
    try {
      return await client.readContract({ address, functionName: fn, args,
        transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      await sleep(2000 * (i + 1));
    }
  }
};
const getElection = async (id) =>
  JSON.parse(await read('get_election', [creator, id]) || 'null');

async function pollReceipt(hash, label) {
  for (let i = 0; i < 240; i++) {
    let receipt = null;
    try {
      receipt = await rpc('eth_getTransactionByHash', [hash]);
    } catch (e) {
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

function save() {
  fs.writeFileSync(journalFile, JSON.stringify(journal,
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
}

async function finalize(label, electionId, expected) {
  const entry = { label, sender: finalizer.address, expected: 'success',
    submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); save();
  entry.hash = await client.writeContract({ address,
    functionName: 'finalize_tally', args: [creator, electionId], value: 0n,
    leaderOnly: false, consensusMaxRotations: 0 });
  save();
  console.log(label, 'SUBMITTED', entry.hash);
  entry.receipt = await pollReceipt(entry.hash, label);
  save();
  const votes = assertSuccessfulConsensus(entry.receipt);
  console.log(label, 'VERIFIED', votes.agree + '/' + votes.total + ' AGREE');
  const el = await getElection(electionId);
  assert.equal(el.state, 'TALLIED');
  assert.equal(el.result.outcome, expected.outcome);
  assert.deepEqual(el.result.counts, expected.counts);
  assert.equal(el.result.winner, expected.winner);
  journal.elections.find((e) => e.id === electionId).final = el;
  save();
  console.log(electionId, 'READBACK', el.result.outcome, el.result.counts,
    'winner:', el.result.winner);
}

try {
  if (BigInt(await rpc('eth_chainId')) !== 61999n) throw Error('WRONG_CHAIN');
  // Pre-checks: the two elections must still be OPEN with the expected
  // revealed ballots; the other two must already be terminal.
  const lunch = await getElection('lunch-vote');
  const mascot = await getElection('mascot-vote');
  const empty = await getElection('empty-vote');
  const cancel = await getElection('cancel-vote');
  console.log('pre-check lunch:', lunch.state,
    'revealed:', lunch.revealed_count, '/ commitments:',
    Object.keys(lunch.commitments).length);
  console.log('pre-check mascot:', mascot.state,
    'revealed:', mascot.revealed_count, '/ commitments:',
    Object.keys(mascot.commitments).length);
  console.log('pre-check empty:', empty.state, empty.result?.outcome);
  console.log('pre-check cancel:', cancel.state);
  assert.equal(lunch.state, 'OPEN');
  assert.equal(lunch.revealed_count, 3);
  assert.equal(mascot.state, 'OPEN');
  assert.equal(mascot.revealed_count, 2);
  assert.equal(empty.state, 'TALLIED');
  assert.equal(empty.result.outcome, 'NO_VOTES');
  assert.equal(cancel.state, 'CANCELLED');

  // Tally opens at hour 01:00 (reveal deadline 00:00). Wait for 2
  // minutes into that hour so leader and validators agree on the bucket.
  const target = new Date('2026-11-10T01:00:00Z');
  for (;;) {
    const now = await utcNow();
    if (now >= new Date(target.getTime() + 120_000)) break;
    console.log('waiting for tally hour | now UTC', now.toISOString());
    await sleep(60_000);
  }

  await finalize('lunch-vote:finalize', 'lunch-vote',
    { outcome: 'DECIDED', counts: [2, 1], winner: 'Noodles' });
  await finalize('mascot-vote:finalize', 'mascot-vote',
    { outcome: 'TIED', counts: [1, 1], winner: 'Mochi' });
  journal.elections.find((e) => e.id === 'empty-vote').final =
    await getElection('empty-vote');
  journal.elections.find((e) => e.id === 'cancel-vote').final =
    await getElection('cancel-vote');
  journal.completed_at = new Date().toISOString();
  save();
  console.log('COMPLETE', address);
} catch (e) {
  journal.error = String(e);
  save();
  console.error(String(e));
  process.exitCode = 1;
}
