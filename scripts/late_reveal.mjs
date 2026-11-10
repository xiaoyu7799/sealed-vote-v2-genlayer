/* Supplementary case: expired reveal (REVEAL_WINDOW_CLOSED), one election.
 *
 * Appends to the existing journal (evidence/live.json) — never rewrites
 * an existing record. Keys live only in process memory; the checkpoint
 * file records addresses, hashes and stage only, never keys.
 *
 *   hour H   (01 UTC): create late-reveal-vote, commit Yes
 *   hour H+2 (03:05 UTC): reveal with the CORRECT salt+option -> must
 *              fail on chain with REVEAL_WINDOW_CLOSED; then finalize
 *              -> NO_VOTES [0,0].
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
const ADDRESS = '0xF68b58AEA5AE127b34917D49e9F830F51FEFB9C0';
assert.equal(journal.contract_address, ADDRESS, 'contract mismatch');

const ELECTION_ID = 'late-reveal-vote';
const OPTION = 'Yes';
const SALT = crypto.randomBytes(18).toString('hex'); // 36 chars, memory only
const TARGET_REVEAL_AT = '2026-11-10T03:05:00Z';

function save() {
  fs.writeFileSync(journalFile, JSON.stringify(journal,
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
}
const checkpoint = { election_id: ELECTION_ID, contract: ADDRESS,
  stage: 'starting', txs: {}, updated_at: new Date().toISOString() };
function saveCheckpoint(stage, extra = {}) {
  checkpoint.stage = stage;
  checkpoint.updated_at = new Date().toISOString();
  Object.assign(checkpoint, extra);
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
async function utcNow() {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=UTC');
      const j = await r.json();
      return new Date(j.dateTime + 'Z');
    } catch (e) {
      if (i === 5) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}
const hourStr = (d) => d.toISOString().slice(0, 13) + ':00:00Z';
const addHours = (d, n) => new Date(d.getTime() + n * 3600_000);

const clients = {};
function account(label) {
  const acc = createAccount();
  clients[label] = createClient({ chain: studionet, account: acc });
  journal.accounts[label] = acc.address;
  save();
  return acc;
}
const creator = account('lateCreator');
const voter = account('lateVoter');

const read = async (fn, args = []) => {
  for (let i = 0; i < 6; i++) {
    try {
      return await clients.lateCreator.readContract({ address: ADDRESS,
        functionName: fn, args, transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      console.log('read retry', fn, String(e).slice(0, 100));
      await sleep(2000 * (i + 1));
    }
  }
};
const getElection = async () =>
  JSON.parse(await read('get_election', [creator.address, ELECTION_ID]) || 'null');

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

async function finalized(label, senderLabel, send) {
  if (journal.transactions.some((t) => t.label === label))
    throw Error('Existing intent: ' + label);
  const entry = { label, sender: journal.accounts[senderLabel],
    expected: 'success', submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); save();
  try {
    entry.hash = await send();
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
  return entry.receipt;
}

const write = (label, fn, args, value = 0n) =>
  clients[label].writeContract({ address: ADDRESS, functionName: fn, args, value,
    leaderOnly: false, consensusMaxRotations: 0 });

function decodeLeaderResults(receipt) {
  const exec = receipt.consensus_data?.leader_receipt;
  const list = Array.isArray(exec) ? exec : [exec];
  return list.map((x) => {
    try { return Buffer.from(x?.result ?? '', 'base64').toString('utf8'); }
    catch { return ''; }
  });
}

try {
  if (BigInt(await rpc('eth_chainId')) !== 61999n) throw Error('WRONG_CHAIN');
  if (BigInt(await rpc('eth_gasPrice')) !== 0n)
    throw Error('NONZERO_GAS_PRICE: no paid transaction allowed');
  const code = fs.readFileSync(new URL('contracts/sealed_vote.py', root), 'utf8');
  if (sha(code) !== journal.source_sha256) throw Error('SOURCE_CHANGED_SINCE_DEPLOY');
  const deployed = await clients.lateCreator.getContractCode(ADDRESS);
  if (deployed !== code) throw Error('DEPLOYED_SOURCE_MISMATCH');
  if (await read('get_protocol') !== 'sealed-vote-1') throw Error('PROTOCOL_MISMATCH');

  const now = await utcNow();
  const H = hourStr(now);
  const H1 = hourStr(addHours(new Date(H), 1));
  assert.equal(H, '2026-11-10T01:00:00Z', 'must run in hour 01 UTC, now ' + now.toISOString());
  assert.equal(H1, '2026-11-10T02:00:00Z');
  console.log('hours: commit <=', H, '| reveal <=', H1, '| late reveal at', TARGET_REVEAL_AT);

  // ---- create + commit (hour H) -----------------------------------------
  saveCheckpoint('creating', { commit_deadline: H, reveal_deadline: H1 });
  await finalized(`${ELECTION_ID}:create`, 'lateCreator', () => write('lateCreator',
    'create_election', [ELECTION_ID, 'Late reveal vote',
      JSON.stringify(['Yes', 'No']), H, H1]));
  const created = await getElection();
  assert.equal(created.state, 'OPEN');
  assert.deepEqual(created.options, ['Yes', 'No']);
  assert.equal(created.commit_deadline, H);
  assert.equal(created.reveal_deadline, H1);
  checkpoint.txs.create = journal.transactions.at(-1).hash;
  saveCheckpoint('created');

  await finalized(`${ELECTION_ID}:commit:lateVoter`, 'lateVoter', () => write('lateVoter',
    'commit_vote', [creator.address, ELECTION_ID, sha(SALT + '|' + OPTION)]));
  const afterCommit = await getElection();
  assert.equal(Object.keys(afterCommit.commitments).length, 1);
  assert.equal(afterCommit.commitments[voter.address.toLowerCase()].commitment,
    sha(SALT + '|' + OPTION));
  assert.equal(afterCommit.commitments[voter.address.toLowerCase()].revealed, false);
  checkpoint.txs.commit = journal.transactions.at(-1).hash;
  saveCheckpoint('committed-waiting', { reveal_at: TARGET_REVEAL_AT });

  // ---- wait until 03:05 UTC (past the reveal deadline hour + 5 min) -----
  for (;;) {
    const t = await utcNow();
    if (t >= new Date(TARGET_REVEAL_AT)) break;
    console.log('waiting for', TARGET_REVEAL_AT, '| now UTC', t.toISOString());
    saveCheckpoint('committed-waiting', { now_utc: t.toISOString(),
      reveal_at: TARGET_REVEAL_AT });
    await sleep(60_000);
  }
  console.log('reveal window passed; attempting late reveal at', (await utcNow()).toISOString());

  // ---- late reveal: correct salt + option, must fail on chain ------------
  const label = `${ELECTION_ID}:reveal-late`;
  if (journal.transactions.some((t) => t.label === label))
    throw Error('Existing intent: ' + label);
  const entry = { label, sender: journal.accounts.lateVoter,
    expected: 'fail', submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); save();
  const before = await getElection();
  entry.hash = await write('lateVoter', 'reveal_vote',
    [creator.address, ELECTION_ID, SALT, OPTION]);
  save();
  console.log(label, 'SUBMITTED (expected to fail on chain)', entry.hash);
  entry.receipt = await pollReceipt(entry.hash, label);
  save();
  assert.equal(entry.receipt.status, 'FINALIZED', 'late reveal not FINALIZED');
  const exec = entry.receipt.consensus_data?.leader_receipt;
  const list = Array.isArray(exec) ? exec : [exec];
  entry.leader_execution = list.map((x) => x?.execution_result);
  if (list.some((x) => x?.execution_result === 'SUCCESS'))
    throw Error(label + ': adversarial call SUCCEEDED on chain');
  if (!list.some((x) => x?.execution_result === 'ERROR'))
    throw Error(label + ': no ERROR execution in receipt');
  const decoded = decodeLeaderResults(entry.receipt);
  entry.error_code = decoded.find((s) => s.includes('REVEAL_WINDOW_CLOSED')) || null;
  if (!entry.error_code) throw Error(label + ': REVEAL_WINDOW_CLOSED not in leader results: ' + JSON.stringify(decoded));
  save();
  const after = await getElection();
  assert.deepEqual(after.commitments, before.commitments, 'state changed despite failed reveal');
  assert.equal(after.revealed_count, 0);
  assert.equal(after.state, 'OPEN');
  checkpoint.txs.reveal_late = entry.hash;
  checkpoint.error_code = 'REVEAL_WINDOW_CLOSED';
  saveCheckpoint('reveal-failed');
  console.log(label, 'FAILED on chain as expected:', entry.leader_execution,
    '| error:', entry.error_code);

  // ---- finalize: NO_VOTES [0,0] ------------------------------------------
  await finalized(`${ELECTION_ID}:finalize`, 'lateCreator', () => write('lateCreator',
    'finalize_tally', [creator.address, ELECTION_ID]));
  const finalEl = await getElection();
  assert.equal(finalEl.state, 'TALLIED');
  assert.equal(finalEl.result.outcome, 'NO_VOTES');
  assert.deepEqual(finalEl.result.counts, [0, 0]);
  assert.equal(finalEl.result.total_revealed, 0);
  assert.equal(finalEl.result.winner, null);
  checkpoint.txs.finalize = journal.transactions.at(-1).hash;
  journal.elections.push({ id: ELECTION_ID, case: 'late-reveal',
    created, final: finalEl, creator: creator.address });
  save();
  saveCheckpoint('done', { final_state: 'TALLIED',
    outcome: 'NO_VOTES', counts: [0, 0] });
  console.log('LATE_REVEAL_COMPLETE', JSON.stringify({
    create: checkpoint.txs.create, commit: checkpoint.txs.commit,
    reveal_late: checkpoint.txs.reveal_late, finalize: checkpoint.txs.finalize,
    error_code: 'REVEAL_WINDOW_CLOSED',
    final: { state: 'TALLIED', outcome: 'NO_VOTES', counts: [0, 0] },
    salt: SALT,
  }, null, 2));
} catch (e) {
  checkpoint.error = String(e);
  saveCheckpoint(checkpoint.stage || 'error');
  try { save(); } catch {}
  console.error('LATE_REVEAL_FAILED', String(e));
  process.exitCode = 1;
}
