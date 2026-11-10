/* SealedVote v2 live run on Stable Studionet (chain 61999).
 *
 * One process runs the whole election cycle, because the test
 * accounts exist only in process memory: their keys are never
 * written to disk, to the journal, or to any log. The journal
 * (evidence/live.json) records addresses, hashes, receipts and
 * readbacks only.
 *
 * Stages are driven by the UTC hour, the same clock the contract
 * reads from timeapi.io:
 *   hour H   : deploy, create elections, commits, early adversarials
 *   hour H+1 : reveals, reveal-phase adversarials, NO_VOTES finalize
 *   hour H+2 : late-reveal adversarial, winner + tie finalizes
 * The script waits for 2 minutes past each hour boundary before
 * acting, so leader and validators agree on the hour bucket.
 * If the process is interrupted, re-run from scratch: the old test
 * elections are abandoned on chain (no funds involved) and a fresh
 * journal is started. Never edit evidence/live.json by hand.
 *
 * Robustness rules learned from earlier runs:
 * - reads and receipt polls retry on transient RPC failures (the RPC
 *   sometimes answers with an HTML error page); a write submission
 *   is NEVER retried, so a transaction is never sent twice.
 * - a receipt poll that ends without FINALIZED keeps the hash in the
 *   journal for later inspection instead of resubmitting.
 */
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { assertSuccessfulConsensus } from './receipt.mjs';

const root = new URL('../', import.meta.url);
const journalFile = new URL('evidence/live.json', root);
const journal = {
  network: { chain_id: 61999, rpc: 'https://studio.genlayer.com/api' },
  started_at: new Date().toISOString(),
  transactions: [], elections: [], accounts: {},
};
function save() {
  fs.mkdirSync(new URL('evidence/', root), { recursive: true });
  fs.writeFileSync(journalFile, JSON.stringify(journal,
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
}
save();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const commitHash = (salt, option) => sha(salt + '|' + option);

// RPC with retries: transient failures (HTML error pages, dropped
// connections) are retried; a JSON-RPC error response is terminal.
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
function hourStr(d) {
  return d.toISOString().slice(0, 13) + ':00:00Z';
}
function addHours(d, n) {
  return new Date(d.getTime() + n * 3600_000);
}
async function waitUntilHour(targetHourStr) {
  for (;;) {
    const now = await utcNow();
    const target = new Date(targetHourStr);
    // act 2 minutes into the target hour: safely inside the bucket
    if (now >= new Date(target.getTime() + 120_000)) return;
    console.log('waiting for', targetHourStr, '| now UTC', now.toISOString());
    await sleep(60_000);
  }
}

const clients = {};
function account(label) {
  const acc = createAccount();
  clients[label] = createClient({ chain: studionet, account: acc });
  journal.accounts[label] = acc.address;
  save();
  return acc;
}
const owner = account('creator');
const voters = {};
for (const label of ['A', 'B', 'C', 'D', 'E', 'G', 'H']) voters[label] = account('voter' + label);
const stranger = account('stranger');

let address = null;
const read = async (fn, args = [], clientLabel = 'creator') => {
  for (let i = 0; i < 6; i++) {
    try {
      return await clients[clientLabel].readContract({ address, functionName: fn, args,
        transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      console.log('read retry', fn, String(e).slice(0, 100));
      await sleep(2000 * (i + 1));
    }
  }
};
const getElection = async (id) =>
  JSON.parse(await read('get_election', [owner.address, id]) || 'null');

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

// A call that must succeed with full consensus.
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

// A call that must NOT take effect. The chain may finalize it as a
// failed execution or the client may reject it before submission;
// either way the proof is the readback afterwards: state unchanged.
async function expectFail(label, senderLabel, send, checkUnchanged) {
  if (journal.transactions.some((t) => t.label === label))
    throw Error('Existing intent: ' + label);
  const entry = { label, sender: journal.accounts[senderLabel],
    expected: 'fail', submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); save();
  const before = await checkUnchanged('before');
  try {
    entry.hash = await send();
    save();
    console.log(label, 'SUBMITTED (expected to fail on chain)', entry.hash);
    try {
      entry.receipt = await pollReceipt(entry.hash, label);
      save();
    } catch (pollErr) {
      entry.poll_error = String(pollErr);
      save();
      console.log(label, 'poll ended:', String(pollErr).slice(0, 160));
    }
    if (entry.receipt) {
      const exec = entry.receipt.consensus_data?.leader_receipt;
      const list = Array.isArray(exec) ? exec : [exec];
      entry.leader_execution = list.map((x) => x?.execution_result);
      if (list.some((x) => x?.execution_result === 'SUCCESS'))
        throw Error(label + ': adversarial call SUCCEEDED on chain');
      console.log(label, 'FAILED on chain as expected:', entry.leader_execution);
    }
  } catch (e) {
    if (entry.hash && entry.receipt &&
        (entry.leader_execution ?? []).includes('SUCCESS')) throw e;
    entry.error = String(e); save();
    console.log(label, 'REJECTED before/without success:', String(e).slice(0, 200));
  }
  const after = await checkUnchanged('after');
  assert.deepEqual(after, before, label + ': state changed despite failure');
  console.log(label, 'STATE UNCHANGED ✓');
}

const write = (label, fn, args, value = 0n) =>
  clients[label].writeContract({ address, functionName: fn, args, value,
    leaderOnly: false, consensusMaxRotations: 0 });

const SALTS = {
  A: 'voter-a-salt-2026', B: 'voter-b-salt-2026', C: 'voter-c-salt-2026',
  D: 'voter-d-salt-2026', E: 'voter-e-salt-2026',
  G: 'voter-g-salt-2026', H: 'voter-h-salt-2026',
};
const CASES = {
  winner: { id: 'lunch-vote', title: 'Lunch vote', options: ['Noodles', 'Rice'],
    votes: { A: 'Noodles', B: 'Noodles', C: 'Rice', G: 'Rice' },
    expected: { outcome: 'DECIDED', counts: [2, 1], winner: 'Noodles' } },
  tie: { id: 'mascot-vote', title: 'Mascot vote', options: ['Mochi', 'Pixel'],
    votes: { D: 'Mochi', E: 'Pixel' },
    expected: { outcome: 'TIED', counts: [1, 1], winner: 'Mochi' } },
  novotes: { id: 'empty-vote', title: 'Empty vote', options: ['Yes', 'No'],
    votes: {}, expected: { outcome: 'NO_VOTES', counts: [0, 0], winner: null } },
  cancel: { id: 'cancel-vote', title: 'Cancel vote', options: ['Yes', 'No'],
    votes: { H: 'Yes' }, expected: { state: 'CANCELLED' } },
};

try {
  if (BigInt(await rpc('eth_chainId')) !== 61999n) throw Error('WRONG_CHAIN');
  if (BigInt(await rpc('eth_gasPrice')) !== 0n)
    throw Error('NONZERO_GAS_PRICE: no paid transaction allowed');
  const code = fs.readFileSync(new URL('contracts/sealed_vote.py', root), 'utf8');
  journal.source_sha256 = sha(code); save();

  // Pick hour H: if we are past :40 of the current hour, wait for the
  // next hour so stage A has a full window for its commits.
  let now = await utcNow();
  if (now.getUTCMinutes() >= 40) {
    const next = new Date(now); next.setUTCMinutes(0, 0, 0);
    await waitUntilHour(hourStr(new Date(next.getTime() + 3600_000)));
    now = await utcNow();
  }
  const H = hourStr(now);
  const H1 = hourStr(addHours(new Date(H), 1));
  const H2 = hourStr(addHours(new Date(H), 2));
  journal.hours = { commit_deadline: H, reveal_deadline: H1, finalize_from: H2 };
  save();
  console.log('hours: commit <=', H, '| reveal <=', H1, '| finalize from', H2);

  // ---- deploy -------------------------------------------------------------
  await finalized('deploy', 'creator', () =>
    clients.creator.deployContract({ code: new TextEncoder().encode(code),
      args: [], leaderOnly: false, consensusMaxRotations: 0 }));
  address = journal.transactions.find((t) => t.label === 'deploy').receipt.to_address;
  journal.contract_address = address; save();
  const deployed = await clients.creator.getContractCode(address);
  if (deployed !== code) throw Error('DEPLOYED_SOURCE_MISMATCH');
  journal.source_verified = true; save();
  if (await read('get_protocol') !== 'sealed-vote-1') throw Error('PROTOCOL_MISMATCH');

  // ---- stage A (hour H): create + commit ---------------------------------
  for (const [name, c] of Object.entries(CASES)) {
    const commitDl = name === 'novotes' ? hourStr(addHours(new Date(H), -1)) : H;
    const revealDl = name === 'novotes' ? H : H1;
    c.commit_deadline = commitDl; c.reveal_deadline = revealDl;
    await finalized(`${c.id}:create`, 'creator', () => write('creator',
      'create_election', [c.id, c.title, JSON.stringify(c.options), commitDl, revealDl]));
    const el = await getElection(c.id);
    assert.equal(el.state, 'OPEN');
    assert.deepEqual(el.options, c.options);
    assert.equal(el.commit_deadline, commitDl);
    assert.equal(el.reveal_deadline, revealDl);
    journal.elections.push({ id: c.id, case: name, created: el });
    save();
  }

  // duplicate election id with a different definition must fail
  await expectFail('lunch-vote:create-conflict', 'creator',
    () => write('creator', 'create_election',
      ['lunch-vote', 'Different title', JSON.stringify(['Noodles', 'Rice']), H, H1]),
    async () => (await getElection('lunch-vote')).title);

  for (const [name, c] of Object.entries(CASES)) {
    for (const [v, option] of Object.entries(c.votes)) {
      await finalized(`${c.id}:commit:${v}`, 'voter' + v, () => write('voter' + v,
        'commit_vote', [owner.address, c.id, commitHash(SALTS[v], option)]));
    }
    const el = await getElection(c.id);
    assert.equal(Object.keys(el.commitments).length, Object.keys(c.votes).length);
  }
  // A1: duplicate commitment must fail
  await expectFail('lunch-vote:commit-duplicate', 'voterA',
    () => write('voterA', 'commit_vote',
      [owner.address, 'lunch-vote', commitHash('voter-a-salt-2026', 'Rice')]),
    async () => Object.keys((await getElection('lunch-vote')).commitments).length);
  // A2: late commit to an election whose commit window already passed
  await expectFail('empty-vote:commit-late', 'voterA',
    () => write('voterA', 'commit_vote',
      [owner.address, 'empty-vote', commitHash('voter-a-salt-2026', 'Yes')]),
    async () => Object.keys((await getElection('empty-vote')).commitments).length);
  // A3: finalize before the reveal deadline must fail
  await expectFail('lunch-vote:finalize-early', 'stranger',
    () => write('stranger', 'finalize_tally', [owner.address, 'lunch-vote']),
    async () => (await getElection('lunch-vote')).state);
  // A4: a stranger cannot cancel someone else's election
  await expectFail('lunch-vote:cancel-stranger', 'stranger',
    () => write('stranger', 'cancel_election', ['lunch-vote']),
    async () => (await getElection('lunch-vote')).state);
  // creator cancels the cancel-case election (zero reveals so far)
  await finalized('cancel-vote:cancel', 'creator',
    () => write('creator', 'cancel_election', ['cancel-vote']));
  assert.equal((await getElection('cancel-vote')).state, 'CANCELLED');
  // A5: committing to a cancelled election must fail
  await expectFail('cancel-vote:commit-after-cancel', 'voterH',
    () => write('voterH', 'commit_vote',
      [owner.address, 'cancel-vote', commitHash(SALTS.H, 'Yes')]),
    async () => (await getElection('cancel-vote')).state);

  // ---- stage B (hour H+1): reveal ------------------------------------------
  await waitUntilHour(H1);
  for (const name of ['winner', 'tie']) {
    const c = CASES[name];
    for (const [v, option] of Object.entries(c.votes)) {
      if (name === 'winner' && v === 'G') continue; // G never reveals on time
      await finalized(`${c.id}:reveal:${v}`, 'voter' + v, () => write('voter' + v,
        'reveal_vote', [owner.address, c.id, SALTS[v], option]));
    }
    const el = await getElection(c.id);
    const revealed = Object.values(el.commitments).filter((e) => e.revealed).length;
    assert.equal(revealed, name === 'winner' ? 3 : 2);
  }
  // B1: wrong salt must fail (G reveals with a wrong salt)
  await expectFail('lunch-vote:reveal-wrong-salt', 'voterG',
    () => write('voterG', 'reveal_vote',
      [owner.address, 'lunch-vote', 'wrong-salt-0000', 'Rice']),
    async () => (await getElection('lunch-vote')).commitments[voters.G.address.toLowerCase()]);
  // B2: wrong option must fail (G reveals the right salt, wrong option)
  await expectFail('lunch-vote:reveal-wrong-option', 'voterG',
    () => write('voterG', 'reveal_vote',
      [owner.address, 'lunch-vote', SALTS.G, 'Noodles']),
    async () => (await getElection('lunch-vote')).commitments[voters.G.address.toLowerCase()]);
  // B3: duplicate reveal must fail
  await expectFail('lunch-vote:reveal-duplicate', 'voterA',
    () => write('voterA', 'reveal_vote',
      [owner.address, 'lunch-vote', SALTS.A, 'Noodles']),
    async () => (await getElection('lunch-vote')).revealed_count);
  // B4: a stranger cannot reveal someone else's commitment, even
  // knowing the published test salt
  await expectFail('lunch-vote:reveal-stranger', 'stranger',
    () => write('stranger', 'reveal_vote',
      [owner.address, 'lunch-vote', SALTS.B, 'Noodles']),
    async () => (await getElection('lunch-vote')).revealed_count);
  // no-votes election finalizes now (hour H+1 > reveal deadline H)
  await finalized('empty-vote:finalize', 'stranger',
    () => write('stranger', 'finalize_tally', [owner.address, 'empty-vote']));
  const empty = await getElection('empty-vote');
  assert.equal(empty.state, 'TALLIED');
  assert.equal(empty.result.outcome, 'NO_VOTES');

  // ---- stage C (hour H+2): late reveal fails, tallies ----------------------
  await waitUntilHour(H2);
  // C1: revealing after the reveal deadline must fail
  await expectFail('lunch-vote:reveal-late', 'voterG',
    () => write('voterG', 'reveal_vote',
      [owner.address, 'lunch-vote', SALTS.G, 'Rice']),
    async () => (await getElection('lunch-vote')).commitments[voters.G.address.toLowerCase()]);
  for (const name of ['winner', 'tie']) {
    const c = CASES[name];
    await finalized(`${c.id}:finalize`, 'stranger',
      () => write('stranger', 'finalize_tally', [owner.address, c.id]));
    const el = await getElection(c.id);
    assert.equal(el.state, 'TALLIED');
    assert.equal(el.result.outcome, c.expected.outcome);
    assert.deepEqual(el.result.counts, c.expected.counts);
    assert.equal(el.result.winner, c.expected.winner);
    journal.elections.find((e) => e.id === c.id).final = el;
    save();
    console.log(c.id, 'READBACK', el.result.outcome, el.result.counts,
      'winner:', el.result.winner);
  }
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
