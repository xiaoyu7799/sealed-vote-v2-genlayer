/* Independent read-back verification of a deployed SealedVote contract.
 * Reads only — no writes. Re-checks every recorded receipt, the
 * deployed source, and every finalized election readback, and
 * recomputes every result hash from the recorded ballots.
 * Usage: node scripts/read.mjs
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { assertSuccessfulConsensus } from './receipt.mjs';

const root = new URL('../', import.meta.url);
const journal = JSON.parse(fs.readFileSync(new URL('evidence/live.json', root), 'utf8'));
const client = createClient({ chain: studionet });
const canon = (x) => JSON.stringify(x === null || typeof x !== 'object' ? x
  : Array.isArray(x) ? x.map((y) => JSON.parse(canon(y)))
  : Object.fromEntries(Object.keys(x).sort().map((k) => [k, JSON.parse(canon(x[k]))])));
const hash = (x) => crypto.createHash('sha256').update(canon(x)).digest('hex');
const address = journal.contract_address;

async function request(method, params = [], attempts = 6) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.request({ method, params });
    } catch (e) {
      if (i === attempts - 1) throw e;
      console.log('request retry', method, String(e).slice(0, 100));
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
async function readContract(fn, args) {
  for (let i = 0; i < 6; i++) {
    try {
      return await client.readContract({ address, functionName: fn, args,
        transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

if (BigInt(await request('eth_chainId', [])) !== 61999n)
  throw Error('WRONG_CHAIN');
if (!journal.completed_at) throw Error('LIVE RUN NOT COMPLETE');

for (const entry of journal.transactions) {
  if (!entry.hash) {
    // rejected before submission: nothing on chain to re-check
    console.log(entry.label, 'no hash (client-side rejection):', (entry.error ?? '').slice(0, 120));
    continue;
  }
  const receipt = await request('eth_getTransactionByHash', [entry.hash]);
  assert.equal(receipt.hash, entry.hash);
  if (entry.expected === 'success') {
    const votes = assertSuccessfulConsensus(receipt);
    console.log(entry.label, entry.hash, receipt.status, votes.agree + '/' + votes.total + ' AGREE');
  } else {
    const exec = receipt.consensus_data?.leader_receipt;
    const list = Array.isArray(exec) ? exec : [exec];
    assert.ok(!list.some((x) => x?.execution_result === 'SUCCESS'),
      entry.label + ' adversarial call succeeded on re-check');
    console.log(entry.label, entry.hash, receipt.status,
      'leader:', list.map((x) => x?.execution_result).join(','));
  }
}
const source = fs.readFileSync(new URL('contracts/sealed_vote.py', root), 'utf8');
if (await client.getContractCode(address) !== source) throw Error('SOURCE_MISMATCH');
console.log('SOURCE VERIFIED', address);

for (const rec of journal.elections) {
  const raw = await readContract('get_election', [rec.creator || journal.accounts.creator, rec.id]);
  const el = JSON.parse(raw);
  if (rec.final) assert.deepEqual(el, rec.final, rec.id + ' readback mismatch');
  if (el.state === 'TALLIED') {
    const r = el.result;
    // recompute the tally from the revealed ballots
    const counts = new Array(el.options.length).fill(0);
    let total = 0;
    for (const e of Object.values(el.commitments)) {
      if (e.revealed) { counts[e.option_index] += 1; total += 1; }
    }
    assert.deepEqual(r.counts, counts);
    assert.equal(r.total_revealed, total);
    const best = Math.max(...counts);
    const tied = counts.map((c, i) => (c === best ? i : -1)).filter((i) => i >= 0);
    const outcome = total === 0 ? 'NO_VOTES' : tied.length === 1 ? 'DECIDED' : 'TIED';
    assert.equal(r.outcome, outcome);
    assert.equal(r.winner_index, total === 0 ? null : tied[0]);
    assert.equal(r.winner, total === 0 ? null : el.options[tied[0]]);
    assert.deepEqual(r.tied_indices, total === 0 ? [] : tied.length === 1 ? [] : tied);
    assert.equal(r.result_hash, hash({ protocol: 'sealed-vote-1', owner: el.owner,
      election_id: el.election_id, options: el.options, counts,
      outcome, winner_index: r.winner_index }));
    assert.equal(el.result_hash, r.result_hash);
    console.log(rec.id, r.outcome, r.counts, 'winner:', r.winner, '| tally + hash rechecked');
  } else {
    console.log(rec.id, el.state, '| terminal state rechecked');
  }
}
console.log('READBACK VERIFIED');
