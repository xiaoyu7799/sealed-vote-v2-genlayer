/* Supplementary case round 2: expired reveal (REVEAL_WINDOW_CLOSED).
 *
 * Election late-reveal-vote-2 — re-run of the expired-reveal case
 * after round 1 (late-reveal-vote) was orphaned by a runtime restart
 * (its salt + temp keys died with that process; it was finalized as
 * NO_VOTES in scripts/finalize_late_reveal.mjs).
 *
 * Schedule (UTC): create + commit in hour H (commit_deadline H,
 * reveal_deadline H+1), reveal attempt at H+2 :02 with the CORRECT
 * salt + option -> must fail on chain with REVEAL_WINDOW_CLOSED,
 * then finalize -> NO_VOTES [0,0]. Planned H is 05:00 on
 * 2026-11-10 (create ~05:55, commit before 05:59, reveal ~07:02);
 * the clock failsafe recomputes H from the current hour if the run
 * starts late (see planFresh).
 *
 * Checkpointing (Sandra, 2026-11-10): this run checkpoints the
 * temporary account keys + salt to checkpoint-late-reveal-2.json so
 * a restart kill resumes instead of redeploying. RED LINES:
 *  - the checkpoint file is gitignored (see .gitignore) and is NEVER
 *    committed, NEVER copied into evidence/live.json, EVIDENCE.md or
 *    any delivery doc, NEVER copied elsewhere;
 *  - it holds ONLY this run's throwaway keys + salt, mode 0600;
 *  - it is DELETED as soon as finalize + evidence + commit + push
 *    are all done (or if the run is abandoned).
 * The script refuses to generate any key before verifying the
 * checkpoint filename is gitignored and untracked.
 *
 * Resume: on startup the script reads the checkpoint first, restores
 * the accounts from the stored keys, verifies every claimed step on
 * chain (get_election with LATEST_FINAL + tx receipts) and continues
 * from the first incomplete step. If the checkpoint names a different
 * contract, it is discarded and the run starts fresh. A successor
 * killed after the commit resumes with the stored salt + voter key
 * and attempts the reveal directly — no re-commit needed.
 *
 * After this script ends with stage 'journaled', the agent still has
 * to: python3 scripts/package_evidence.py, append the EVIDENCE.md
 * supplementary section, run `npm run read` + verify_proof.py,
 * commit + push, then DELETE checkpoint-late-reveal-2.json.
 */
import { createAccount, createClient, generatePrivateKey } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { assertSuccessfulConsensus } from './receipt.mjs';

const root = new URL('../', import.meta.url);
const rootPath = new URL('../', import.meta.url).pathname;
const journalFile = new URL('evidence/live.json', root);
const checkpointFile = new URL('checkpoint-late-reveal-2.json', root);
const CHECKPOINT_NAME = 'checkpoint-late-reveal-2.json';
const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
const ADDRESS = '0xF68b58AEA5AE127b34917D49e9F830F51FEFB9C0';
assert.equal(journal.contract_address, ADDRESS, 'contract mismatch');

const ELECTION_BASE = 'late-reveal-vote-2';
let electionId = ELECTION_BASE;
const OPTION = 'Yes';
const LABELS = { creator: 'lateCreator2', voter: 'lateVoter2' };

// ---- checkpoint guards: run BEFORE any key is generated ---------------
const gitignore = fs.readFileSync(new URL('.gitignore', root), 'utf8');
if (!gitignore.split('\n').some((l) => l.trim() === CHECKPOINT_NAME))
  throw Error('REFUSING: ' + CHECKPOINT_NAME + ' not in .gitignore');
try {
  execSync('git check-ignore -q ' + CHECKPOINT_NAME, { cwd: rootPath });
} catch {
  throw Error('REFUSING: git does not ignore ' + CHECKPOINT_NAME);
}
try {
  execSync('git ls-files --error-unmatch ' + CHECKPOINT_NAME,
    { cwd: rootPath, stdio: 'pipe' });
  throw Error('REFUSING: ' + CHECKPOINT_NAME + ' is tracked by git');
} catch (e) {
  if (String(e.message).startsWith('REFUSING')) throw e;
  // ls-files failing means "not tracked": the expected outcome.
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- checkpoint --------------------------------------------------------
let checkpoint = null;
function saveCheckpoint() {
  checkpoint.updated_at = new Date().toISOString();
  fs.writeFileSync(checkpointFile,
    JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(checkpointFile, 0o600);
}
function loadCheckpoint() {
  if (!fs.existsSync(checkpointFile)) return null;
  const cp = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  if (cp.contract !== ADDRESS) {
    console.log('checkpoint names a different contract (' + cp.contract +
      '); discarding it and starting fresh');
    fs.unlinkSync(checkpointFile);
    return null;
  }
  if (!cp.election_id.startsWith(ELECTION_BASE)) {
    console.log('checkpoint is for another election; discarding it');
    fs.unlinkSync(checkpointFile);
    return null;
  }
  electionId = cp.election_id;
  return cp;
}

// ---- rpc / time --------------------------------------------------------
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
async function waitUntil(targetISO, note) {
  for (;;) {
    const t = await utcNow();
    if (t >= new Date(targetISO)) return t;
    console.log('waiting for', targetISO, note || '', '| now UTC', t.toISOString());
    if (checkpoint) { checkpoint.now_utc = t.toISOString(); saveCheckpoint(); }
    await sleep(60_000);
  }
}

// ---- clients ------------------------------------------------------------
const reader = createClient({ chain: studionet });
const clients = {};
function restoreAccount(label, privateKey) {
  const acc = createAccount(privateKey);
  clients[label] = createClient({ chain: studionet, account: acc });
  return acc;
}
const read = async (fn, args = []) => {
  for (let i = 0; i < 6; i++) {
    try {
      return await reader.readContract({ address: ADDRESS,
        functionName: fn, args, transactionHashVariant: 'latest-final' });
    } catch (e) {
      if (i === 5) throw e;
      console.log('read retry', fn, String(e).slice(0, 100));
      await sleep(2000 * (i + 1));
    }
  }
};
const getElection = async (creatorAddr) =>
  JSON.parse(await read('get_election', [creatorAddr, electionId]) || 'null');

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
function saveJournal() {
  fs.writeFileSync(journalFile, JSON.stringify(journal,
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
}
function decodeLeaderResults(receipt) {
  const exec = receipt.consensus_data?.leader_receipt;
  const list = Array.isArray(exec) ? exec : [exec];
  return list.map((x) => {
    try { return Buffer.from(x?.result ?? '', 'base64').toString('utf8'); }
    catch { return ''; }
  });
}

// ---- plan ---------------------------------------------------------------
// Fresh-start clock failsafe: commit = current hour H, reveal = H+1,
// reveal attempt = H+2 :02. The planned run is H = 2026-11-10T05:00:00Z
// (create ~05:55, reveal ~07:02). If started with <5 min left in the
// hour, roll to the next hour so create+commit have a full window.
function planFresh(now) {
  const H = hourStr(now);
  const m = now.getUTCMinutes();
  if (H === '2026-11-10T05:00:00Z' && m < 55) {
    return { commit_deadline: '2026-11-10T05:00:00Z',
      reveal_deadline: '2026-11-10T06:00:00Z',
      create_at: '2026-11-10T05:55:00Z',
      reveal_at: '2026-11-10T07:02:00Z' };
  }
  if (m < 50) {
    const h1 = hourStr(addHours(new Date(H), 1));
    const h2 = hourStr(addHours(new Date(H), 2));
    return { commit_deadline: H, reveal_deadline: h1,
      create_at: now.toISOString(),
      reveal_at: new Date(new Date(h2).getTime() + 120_000).toISOString() };
  }
  const h1 = hourStr(addHours(new Date(H), 1));
  const h2 = hourStr(addHours(new Date(H), 2));
  const h3 = hourStr(addHours(new Date(H), 3));
  return { commit_deadline: h1, reveal_deadline: h2,
    create_at: new Date(new Date(h1).getTime() + 120_000).toISOString(),
    reveal_at: new Date(new Date(h3).getTime() + 120_000).toISOString() };
}

// ---- tx helpers -----------------------------------------------------------
async function submitSuccess(label, senderLabel, send) {
  if (journal.transactions.some((t) => t.label === label))
    throw Error('Existing intent: ' + label);
  const entry = { label, sender: journal.accounts[senderLabel],
    expected: 'success', submitted_at: new Date().toISOString(), hash: null };
  journal.transactions.push(entry); saveJournal();
  try {
    entry.hash = await send();
    saveJournal();
    console.log(label, 'SUBMITTED', entry.hash);
  } catch (e) {
    entry.error = String(e); saveJournal();
    throw Error(label + ' submission uncertain: ' + String(e));
  }
  entry.receipt = await pollReceipt(entry.hash, label);
  saveJournal();
  const votes = assertSuccessfulConsensus(entry.receipt);
  console.log(label, 'VERIFIED', votes.agree + '/' + votes.total + ' AGREE');
  return entry;
}
const write = (label, fn, args, value = 0n) =>
  clients[label].writeContract({ address: ADDRESS, functionName: fn, args, value,
    leaderOnly: false, consensusMaxRotations: 0 });

// ---- main -----------------------------------------------------------------
let creator; let voter;
try {
  if (BigInt(await rpc('eth_chainId')) !== 61999n) throw Error('WRONG_CHAIN');
  if (BigInt(await rpc('eth_gasPrice')) !== 0n)
    throw Error('NONZERO_GAS_PRICE: no paid transaction allowed');
  const code = fs.readFileSync(new URL('contracts/sealed_vote.py', root), 'utf8');
  if (sha(code) !== journal.source_sha256) throw Error('SOURCE_CHANGED_SINCE_DEPLOY');
  const deployed = await reader.getContractCode(ADDRESS);
  if (deployed !== code) throw Error('DEPLOYED_SOURCE_MISMATCH');
  if (await read('get_protocol') !== 'sealed-vote-1') throw Error('PROTOCOL_MISMATCH');

  checkpoint = loadCheckpoint();
  let plan;
  if (!checkpoint) {
    // ---- fresh start: keys + salt first, checkpoint v1 BEFORE any tx ----
    const now = await utcNow();
    plan = planFresh(now);
    const creatorKey = generatePrivateKey();
    const voterKey = generatePrivateKey();
    const salt = crypto.randomBytes(18).toString('hex'); // 36 chars
    creator = restoreAccount(LABELS.creator, creatorKey);
    voter = restoreAccount(LABELS.voter, voterKey);
    checkpoint = { election_id: electionId, contract: ADDRESS,
      stage: 'accounts', option: OPTION, salt,
      commit_deadline: plan.commit_deadline,
      reveal_deadline: plan.reveal_deadline,
      create_at: plan.create_at, reveal_at: plan.reveal_at,
      keys: { creator: { address: creator.address, privateKey: creatorKey },
              voter: { address: voter.address, privateKey: voterKey } },
      txs: {}, cases: { create: 'pending', commit: 'pending',
        reveal_late: 'pending', finalize: 'pending' },
      updated_at: new Date().toISOString() };
    saveCheckpoint();
    journal.accounts[LABELS.creator] = creator.address;
    journal.accounts[LABELS.voter] = voter.address;
    saveJournal();
    console.log('checkpoint v1 written (accounts+salt, 0600) for',
      electionId, '| create at', plan.create_at);
  } else {
    // ---- resume: restore accounts, verify every claimed step on chain --
    console.log('resuming from checkpoint, stage:', checkpoint.stage);
    plan = { commit_deadline: checkpoint.commit_deadline,
      reveal_deadline: checkpoint.reveal_deadline,
      create_at: checkpoint.create_at, reveal_at: checkpoint.reveal_at };
    creator = restoreAccount(LABELS.creator,
      checkpoint.keys.creator.privateKey);
    voter = restoreAccount(LABELS.voter,
      checkpoint.keys.voter.privateKey);
    assert.equal(creator.address, checkpoint.keys.creator.address,
      'creator key/address mismatch');
    assert.equal(voter.address, checkpoint.keys.voter.address,
      'voter key/address mismatch');
    journal.accounts[LABELS.creator] = creator.address;
    journal.accounts[LABELS.voter] = voter.address;
    saveJournal();
    // Receipts for every claimed tx must be FINALIZED; poll briefly if
    // a previous run died mid-poll (the tx may have finalized since).
    for (const [step, hash] of Object.entries(checkpoint.txs)) {
      if (!hash || step === 'reveal_attempts') continue;
      const receipt = await pollReceipt(hash, 'resume-check:' + step);
      assert.equal(receipt.status, 'FINALIZED', step + ' not FINALIZED');
      console.log('resume-check', step, hash.slice(0, 18) + '… FINALIZED');
    }
    const el = await getElection(creator.address);
    // Adopt steps that completed on chain but whose checkpoint update
    // was lost to a kill (the windows between FINALIZED and the
    // checkpoint write are seconds wide, but a restart can land in
    // them). Adoption only moves the stage forward, and only when the
    // chain state + the journal entry agree.
    const journalTx = (label) =>
      journal.transactions.find((t) => t.label === label);
    if ((checkpoint.stage === 'accounts' || checkpoint.stage === 'created')
        && el && el.state === 'OPEN'
        && Object.keys(el.commitments).length === 0
        && el.commit_deadline === plan.commit_deadline
        && el.reveal_deadline === plan.reveal_deadline) {
      const ce = journalTx(`${electionId}:create`);
      if (ce?.hash) {
        await pollReceipt(ce.hash, 'resume-adopt:create');
        checkpoint.txs.create = ce.hash; checkpoint.created = el;
        checkpoint.cases.create = 'done'; checkpoint.stage = 'created';
        saveCheckpoint();
        console.log('resume-adopt: create was already on chain; adopted');
      }
    }
    if (checkpoint.stage === 'created' && el && el.state === 'OPEN'
        && Object.keys(el.commitments).length === 1
        && el.revealed_count === 0
        && el.commitments[voter.address.toLowerCase()]?.commitment ===
          sha(checkpoint.salt + '|' + checkpoint.option)) {
      const ce = journalTx(`${electionId}:commit:${LABELS.voter}`);
      if (ce?.hash) {
        await pollReceipt(ce.hash, 'resume-adopt:commit');
        checkpoint.txs.commit = ce.hash;
        checkpoint.cases.commit = 'done';
        checkpoint.stage = 'committed-waiting';
        saveCheckpoint();
        console.log('resume-adopt: commit was already on chain; adopted');
      }
    }
    if (checkpoint.stage === 'committed-waiting') {
      const re = journalTx(`${electionId}:reveal-late`);
      if (re?.hash && re.receipt?.status === 'FINALIZED') {
        const exec = re.receipt.consensus_data?.leader_receipt;
        const list = Array.isArray(exec) ? exec : [exec];
        if (!list.some((x) => x?.execution_result === 'SUCCESS')
            && decodeLeaderResults(re.receipt)
              .some((s) => s.includes('REVEAL_WINDOW_CLOSED'))) {
          checkpoint.txs.reveal_late = re.hash;
          checkpoint.txs.reveal_attempts = re.attempts || [re.hash];
          checkpoint.error_code = 'REVEAL_WINDOW_CLOSED';
          checkpoint.cases.reveal_late = 'done';
          checkpoint.stage = 'reveal-failed';
          saveCheckpoint();
          console.log('resume-adopt: failed reveal was already on chain; adopted');
        }
      }
    }
    if (checkpoint.stage === 'reveal-failed' && el && el.state === 'TALLIED'
        && el.result?.outcome === 'NO_VOTES'
        && JSON.stringify(el.result.counts) === '[0,0]') {
      const fe = journalTx(`${electionId}:finalize`);
      if (fe?.hash) {
        await pollReceipt(fe.hash, 'resume-adopt:finalize');
        checkpoint.txs.finalize = fe.hash;
        checkpoint.cases.finalize = 'done';
        checkpoint.stage = 'finalized';
        saveCheckpoint();
        console.log('resume-adopt: finalize was already on chain; adopted');
      }
    }
    const stage = checkpoint.stage;
    if (stage === 'accounts') {
      assert.equal(el, null, 'election exists but checkpoint says accounts');
    } else if (stage === 'created') {
      assert.equal(el.state, 'OPEN');
      assert.equal(Object.keys(el.commitments).length, 0);
      assert.equal(el.commit_deadline, plan.commit_deadline);
      assert.equal(el.reveal_deadline, plan.reveal_deadline);
    } else if (stage === 'committed-waiting' || stage === 'reveal-failed') {
      assert.equal(el.state, 'OPEN');
      assert.equal(Object.keys(el.commitments).length, 1);
      assert.equal(el.revealed_count, 0);
      assert.equal(el.commitments[voter.address.toLowerCase()].commitment,
        sha(checkpoint.salt + '|' + checkpoint.option));
      if (stage === 'reveal-failed') {
        const receipt = await rpc('eth_getTransactionByHash',
          [checkpoint.txs.reveal_late]);
        const exec = receipt.consensus_data?.leader_receipt;
        const list = Array.isArray(exec) ? exec : [exec];
        assert.ok(!list.some((x) => x?.execution_result === 'SUCCESS'),
          'reveal unexpectedly SUCCEEDED');
        assert.ok(decodeLeaderResults(receipt)
          .some((s) => s.includes('REVEAL_WINDOW_CLOSED')),
          'stored reveal receipt lacks REVEAL_WINDOW_CLOSED');
      }
    } else if (stage === 'finalized' || stage === 'journaled') {
      assert.equal(el.state, 'TALLIED');
      assert.equal(el.result.outcome, 'NO_VOTES');
      assert.deepEqual(el.result.counts, [0, 0]);
    } else {
      throw Error('unknown checkpoint stage: ' + stage);
    }
    console.log('resume-check passed for stage', stage);
    // A 'created' election whose commit hour has passed can never take
    // a commit: discard and restart with fresh accounts (same id is
    // free under the fresh creator namespace).
    if (stage === 'created' || stage === 'accounts') {
      const now = await utcNow();
      if (hourStr(now) > plan.commit_deadline) {
        console.log('commit hour passed for a never-committed election;',
          'discarding checkpoint and restarting fresh');
        fs.unlinkSync(checkpointFile);
        checkpoint = null;
        // Fresh election id (hour suffix): the old id is taken under
        // the old creator, and the journal already holds its create
        // label, so a bare retry would collide on both.
        electionId = ELECTION_BASE + '-' + hourStr(now).slice(11, 13);
        const freshPlan = planFresh(now);
        const creatorKey = generatePrivateKey();
        const voterKey = generatePrivateKey();
        const salt = crypto.randomBytes(18).toString('hex');
        creator = restoreAccount(LABELS.creator, creatorKey);
        voter = restoreAccount(LABELS.voter, voterKey);
        checkpoint = { election_id: electionId, contract: ADDRESS,
          stage: 'accounts', option: OPTION, salt,
          commit_deadline: freshPlan.commit_deadline,
          reveal_deadline: freshPlan.reveal_deadline,
          create_at: freshPlan.create_at, reveal_at: freshPlan.reveal_at,
          keys: { creator: { address: creator.address, privateKey: creatorKey },
                  voter: { address: voter.address, privateKey: voterKey } },
          txs: {}, cases: { create: 'pending', commit: 'pending',
            reveal_late: 'pending', finalize: 'pending' },
          updated_at: new Date().toISOString() };
        saveCheckpoint();
        journal.accounts[LABELS.creator] = creator.address;
        journal.accounts[LABELS.voter] = voter.address;
        saveJournal();
        plan = freshPlan;
      }
    }
  }

  const stageIs = (...s) => s.includes(checkpoint.stage);
  const salt = checkpoint.salt;

  // ---- create (hour H) ---------------------------------------------------
  let created = checkpoint.created || null;
  if (stageIs('accounts')) {
    await waitUntil(plan.create_at, '(create window)');
    const now = await utcNow();
    assert.ok(hourStr(now) <= plan.commit_deadline,
      'create started after commit deadline hour: ' + now.toISOString());
    await submitSuccess(`${electionId}:create`, LABELS.creator, () =>
      write(LABELS.creator, 'create_election', [electionId,
        'Late reveal vote 2', JSON.stringify(['Yes', 'No']),
        plan.commit_deadline, plan.reveal_deadline]));
    created = await getElection(creator.address);
    assert.equal(created.state, 'OPEN');
    assert.deepEqual(created.options, ['Yes', 'No']);
    assert.equal(created.commit_deadline, plan.commit_deadline);
    assert.equal(created.reveal_deadline, plan.reveal_deadline);
    checkpoint.txs.create = journal.transactions.at(-1).hash;
    checkpoint.created = created;
    checkpoint.cases.create = 'done';
    checkpoint.stage = 'created';
    saveCheckpoint();
    console.log('created', electionId, 'checkpoint updated');
  } else {
    created = checkpoint.created;
  }

  // ---- commit (hour H, before the hour ends) ------------------------------
  if (stageIs('created')) {
    await submitSuccess(`${electionId}:commit:${LABELS.voter}`,
      LABELS.voter, () => write(LABELS.voter, 'commit_vote',
        [creator.address, electionId, sha(salt + '|' + OPTION)]));
    const afterCommit = await getElection(creator.address);
    assert.equal(Object.keys(afterCommit.commitments).length, 1);
    assert.equal(afterCommit.commitments[voter.address.toLowerCase()].commitment,
      sha(salt + '|' + OPTION));
    assert.equal(afterCommit.commitments[voter.address.toLowerCase()].revealed, false);
    checkpoint.txs.commit = journal.transactions.at(-1).hash;
    checkpoint.cases.commit = 'done';
    checkpoint.stage = 'committed-waiting';
    saveCheckpoint();
    console.log('committed; checkpoint updated (salt+keys on disk) —',
      'safe to be killed while waiting for', plan.reveal_at);
  }

  // ---- wait until past the reveal deadline --------------------------------
  if (stageIs('committed-waiting')) {
    const now = await utcNow();
    let revealAt = plan.reveal_at;
    if (now >= new Date(revealAt)) {
      // Resumed after the planned attempt time: still valid as long as
      // we are past the reveal deadline; otherwise wait for the next
      // :02 past it.
      const rd = new Date(plan.reveal_deadline);
      if (now <= rd) {
        revealAt = new Date(rd.getTime() + 3600_000 + 120_000).toISOString();
        checkpoint.reveal_at = revealAt;
        saveCheckpoint();
      }
    }
    await waitUntil(revealAt, '(late reveal)');
    console.log('reveal window passed; attempting late reveal at',
      (await utcNow()).toISOString());
  }

  // ---- late reveal: correct salt + option, must fail on chain -------------
  if (stageIs('committed-waiting')) {
    const label = `${electionId}:reveal-late`;
    let entry = journal.transactions.find((t) => t.label === label);
    if (!entry) {
      entry = { label, sender: journal.accounts[LABELS.voter],
        expected: 'fail', submitted_at: new Date().toISOString(),
        hash: null, attempts: [] };
      journal.transactions.push(entry); saveJournal();
    }
    entry.attempts ??= [];
    const before = await getElection(creator.address);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      if (!entry.hash) {
        try {
          entry.hash = await write(LABELS.voter, 'reveal_vote',
            [creator.address, electionId, salt, OPTION]);
          entry.attempts.push(entry.hash);
          saveJournal();
          console.log(label, 'SUBMITTED (expected to fail on chain)',
            entry.hash, 'attempt', attempt);
        } catch (e) {
          entry.error = String(e); saveJournal();
          console.log(label, 'submission failed, retrying:', String(e).slice(0, 160));
          await sleep(90_000);
          continue;
        }
      }
      try {
        entry.receipt = await pollReceipt(entry.hash, label);
      } catch (e) {
        // Consensus failed at the hour boundary: no state was written,
        // so the attempt may be retried with a fresh submission.
        console.log(label, 'poll ended:', String(e).slice(0, 160),
          '— verifying no state change, then retrying');
        const mid = await getElection(creator.address);
        assert.deepEqual(mid.commitments, before.commitments,
          'state changed despite failed reveal attempt');
        assert.equal(mid.revealed_count, 0);
        entry.hash = null; // fresh submission next attempt
        await sleep(90_000);
        continue;
      }
      saveJournal();
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
      if (!entry.error_code)
        throw Error(label + ': REVEAL_WINDOW_CLOSED not in leader results: ' +
          JSON.stringify(decoded));
      saveJournal();
      const after = await getElection(creator.address);
      assert.deepEqual(after.commitments, before.commitments,
        'state changed despite failed reveal');
      assert.equal(after.revealed_count, 0);
      assert.equal(after.state, 'OPEN');
      checkpoint.txs.reveal_late = entry.hash;
      checkpoint.txs.reveal_attempts = entry.attempts;
      checkpoint.error_code = 'REVEAL_WINDOW_CLOSED';
      checkpoint.cases.reveal_late = 'done';
      checkpoint.stage = 'reveal-failed';
      saveCheckpoint();
      console.log(label, 'FAILED on chain as expected:',
        entry.leader_execution, '| error:', entry.error_code);
      done = true;
    }
    if (!done) throw Error(label + ': reveal attempt exhausted retries');
  }

  // ---- finalize: NO_VOTES [0,0] ------------------------------------------
  let finalEl;
  if (stageIs('reveal-failed')) {
    await submitSuccess(`${electionId}:finalize`, LABELS.creator, () =>
      write(LABELS.creator, 'finalize_tally', [creator.address, electionId]));
    finalEl = await getElection(creator.address);
    assert.equal(finalEl.state, 'TALLIED');
    assert.equal(finalEl.result.outcome, 'NO_VOTES');
    assert.deepEqual(finalEl.result.counts, [0, 0]);
    assert.equal(finalEl.result.total_revealed, 0);
    assert.equal(finalEl.result.winner, null);
    checkpoint.txs.finalize = journal.transactions.at(-1).hash;
    checkpoint.cases.finalize = 'done';
    checkpoint.stage = 'finalized';
    saveCheckpoint();
  } else {
    finalEl = await getElection(creator.address);
    assert.equal(finalEl.state, 'TALLIED');
    assert.equal(finalEl.result.outcome, 'NO_VOTES');
    assert.deepEqual(finalEl.result.counts, [0, 0]);
  }

  // ---- journal: append election record (idempotent) -----------------------
  if (!journal.elections.some((e) => e.id === electionId)) {
    journal.elections.push({ id: electionId, case: 'late-reveal',
      created, final: finalEl, creator: creator.address });
    saveJournal();
  } else {
    const rec = journal.elections.find((e) => e.id === electionId);
    assert.deepEqual(rec.final, finalEl, 'stored final differs from chain');
  }
  checkpoint.stage = 'journaled';
  saveCheckpoint();
  console.log('LATE_REVEAL_2_COMPLETE', JSON.stringify({
    create: checkpoint.txs.create, commit: checkpoint.txs.commit,
    reveal_late: checkpoint.txs.reveal_late,
    finalize: checkpoint.txs.finalize,
    error_code: 'REVEAL_WINDOW_CLOSED',
    final: { state: 'TALLIED', outcome: 'NO_VOTES', counts: [0, 0] },
  }, null, 2));
  console.log('NEXT (agent): python3 scripts/package_evidence.py; append ' +
    'EVIDENCE.md section; npm run read; python3 scripts/verify_proof.py; ' +
    'commit + push; then DELETE ' + CHECKPOINT_NAME + ' and report it.');
} catch (e) {
  if (checkpoint) {
    checkpoint.error = String(e);
    try { saveCheckpoint(); } catch {}
  }
  try { saveJournal(); } catch {}
  console.error('LATE_REVEAL_2_FAILED', String(e));
  process.exitCode = 1;
}
