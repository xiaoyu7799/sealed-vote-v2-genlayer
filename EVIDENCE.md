# SealedVote — network evidence

## Deployment

- Network: Stable Studionet, chain ID 61999, RPC `https://studio.genlayer.com/api`
- Contract: `0xF68b58AEA5AE127b34917D49e9F830F51FEFB9C0`
- Source: `contracts/sealed_vote.py`, SHA-256 `7adcbfcfefccde423e8abff2504b37842f79f6e3a55650c3700cab279f208764` (matches the deployed code; recheck with `npm run read`)
- Protocol version: `sealed-vote-1` (read back from `get_protocol`)
- Deployed: 2026-11-09T22:51:59.749Z – 2026-11-10T01:04:03.312Z
- Hours: commit deadline 2026-11-09T23:00:00Z, reveal deadline 2026-11-10T00:00:00Z, finalize from 2026-11-10T01:00:00Z

## Live verification

Every transaction below reached FINALIZED. Success cases show majority agreement (3/5 validators agree); adversarial cases were finalized as failed executions (`ERROR`) and the election state was read back unchanged afterwards. Full receipts and readbacks are in `evidence/live.json`; `npm run read` re-checks every receipt, the deployed source and every finalized readback without sending a transaction, and `python scripts/verify_proof.py` independently replays every tally and commitment hash offline.

### Elections

- `lunch-vote` (winner): TALLIED — outcome `DECIDED`, counts `[2, 1]`, winner `Noodles`, result hash `50b61beac52ba8be…`
- `mascot-vote` (tie): TALLIED — outcome `TIED`, counts `[1, 1]`, winner `Mochi`, result hash `2f85e859f3efd2c4…`
- `empty-vote` (novotes): TALLIED — outcome `NO_VOTES`, counts `[0, 0]`, winner `None`, result hash `fbcc2cc54d91b0d1…`
- `cancel-vote` (cancel): CANCELLED
- `late-reveal-vote` (late-reveal): TALLIED — outcome `NO_VOTES`, counts `[0, 0]`, winner `None`, result hash `404fd070c141d5e1…`

### Transactions

| Case | Expected | Hash | Status | Consensus |
| --- | --- | --- | --- | --- |
| deploy | success | `0xe113561b4c96e6efba797ef67c1964e71a804917ac7a1caab85178a313df7207` | FINALIZED | 3/5 agree |
| lunch-vote:create | success | `0xddbc87c0680315340f589998690fb0afb749ca366a1b0a0df3255e38b99ca369` | FINALIZED | 3/5 agree |
| mascot-vote:create | success | `0xfe24b270a035e9de9b423f3cedbe227c3acf27067e68f441dabe1aafe6739521` | FINALIZED | 4/5 agree |
| empty-vote:create | success | `0x5f4447fca5aaaf7873b98cf15bf8bf2f54e4ace73c42e0bf219d2abada6d9d20` | FINALIZED | 3/5 agree |
| cancel-vote:create | success | `0x8200820cecab2cd86a761ee5de6f1b0cf56363f61ac87bb5983ed02cfe70ca97` | FINALIZED | 3/5 agree |
| lunch-vote:create-conflict | fail | `0xb00fee615374f558f81410edb26cb1ba98d743c6e64279dd97c33f8303a2f1d3` | FINALIZED | 3/5 agree |
| lunch-vote:commit:A | success | `0x729551b06a141146f2328eec48b6f00892bf2427622468c153a9ab34caca860a` | FINALIZED | 3/5 agree |
| lunch-vote:commit:B | success | `0x89e430bb6079d5854555ad6a8489190574cc7461f7df91d73c2755180d05d103` | FINALIZED | 3/5 agree |
| lunch-vote:commit:C | success | `0xa3b884eefe8ad0b8ea14106a7e4d9ecacf125cb28ee8c777dda72d8832b625b6` | FINALIZED | 3/5 agree |
| lunch-vote:commit:G | success | `0xcd5630c63db89d3cad046a47814c217db6a868f9c9784828de674757cdd5231c` | FINALIZED | 3/5 agree |
| mascot-vote:commit:D | success | `0x5cdd2b75f36cadc253b9e316c7c8e458ff0a6307643bd67f3d981047298fa5f6` | FINALIZED | 3/5 agree |
| mascot-vote:commit:E | success | `0x15af6200c4d7eeef28a7845a69e89293b04e9443377bf193080c7fb1316e7c49` | FINALIZED | 3/5 agree |
| cancel-vote:commit:H | success | `0x27532603f803a9ba97cc62e8092747d2179d5ed02488b5c6cc218da05bf275ff` | FINALIZED | 3/5 agree |
| lunch-vote:commit-duplicate | fail | `0x36ea9af87079d0caf2bc35a2681a140e4f7e58a341b7538d1502e8d62224a295` | FINALIZED | 3/5 agree |
| empty-vote:commit-late | fail | `0xb58338e629e9afac30c4782e01d21295ffb91d63fb67257438cf6d39d1a967cc` | FINALIZED | 3/5 agree |
| lunch-vote:finalize-early | fail | `0xe527b99cd7fba82c8081fc7571820db4e87028798d462055ecdc3741a14489d9` | FINALIZED | 3/5 agree |
| lunch-vote:cancel-stranger | fail | `0x8d42537da6a94c0619bdadca90a393be1223087c14330f8691f8d2664973f08e` | FINALIZED | 4/5 agree |
| cancel-vote:cancel | success | `0xf3a8e117be1eea687dfd957b7a1fab05a92c8630c66522a426734ff3dc49b622` | FINALIZED | 3/5 agree |
| cancel-vote:commit-after-cancel | fail | `0xd02fb3a6b6bb7f531c02d04f39658feebc3839cc3ec410c082ac21e2bc0888bd` | FINALIZED | 4/5 agree |
| lunch-vote:reveal:A | success | `0xbfdc2efe0657406c00b67d9d80ea5a59d708da6c5e4b60e7d8c378e4033be80e` | FINALIZED | 3/5 agree |
| lunch-vote:reveal:B | success | `0x01586e9b51b25a49ae7ac6b8c2345f29af52a9f3370c7137ae6e015555554f6c` | FINALIZED | 3/5 agree |
| lunch-vote:reveal:C | success | `0xed6ac76cf2bbc55b573a5a844699e3c7b28bd8f58cc52b8e21236fbcb13d03d0` | FINALIZED | 3/5 agree |
| mascot-vote:reveal:D | success | `0x1a2ee3d9827bbf96137762f95dd6a5749e69481aededcd5f09fb262e3a4ec6b5` | FINALIZED | 3/5 agree |
| mascot-vote:reveal:E | success | `0x6c9ab2aa5af71d8f939cebc4b47cf9f91309ef6daa5c7047e8ffcd31674cf44a` | FINALIZED | 3/5 agree |
| lunch-vote:reveal-wrong-salt | fail | `0xb6eeef60ca6a0dd117a1c5a72fdfb04ac5ddb6b259483d61fca31e6e292fd2d5` | FINALIZED | 3/5 agree |
| lunch-vote:reveal-wrong-option | fail | `0x01bfde5588456758ea572169e17123339a623a892263b8ed50d00a4937fe763b` | FINALIZED | 3/5 agree |
| lunch-vote:reveal-duplicate | fail | `0x4b205d06b38fee7fb006c4b3c7538772bc02a1eb64a7ffbdd1a5dbe93c21f313` | FINALIZED | 3/5 agree |
| lunch-vote:reveal-stranger | fail | `0x51c3fa6a3b73cbf3f5bb0c76d9e463c5f6d4f8d81afb304cacc9bcbb69b5ac69` | FINALIZED | 3/5 agree |
| empty-vote:finalize | success | `0xd0840e551113bde9811cdb1c102dc0a41b6d5ea1015d4c9f86143c5b5c293802` | FINALIZED | 4/5 agree |
| lunch-vote:finalize | success | `0xb68991c75e4dbd636604693a4f789b4544769739d74a491f4449480a96d1fc91` | FINALIZED | 3/5 agree |
| mascot-vote:finalize | success | `0x17b6ed652ea912fe2bbe8b2c3c22594e1a36f9d4e14b64a5662adaa906dd6597` | FINALIZED | 3/5 agree |
| late-reveal-vote:create | success | `0xffe2da38edfc56e067ccee62133f5d7fb0e3e2537bcc49bf9f09c311cc32977a` | FINALIZED | 3/5 agree |
| late-reveal-vote:commit:lateVoter | success | `0x335435a435e50037cea31128254289ab651313662199030c6af948047555a652` | FINALIZED | 3/5 agree |
| late-reveal-vote:finalize | success | `0x40e8a3df4e7daeddc4327d5d7235d6ea5a14b1cc0a98c60ad8046a01345062f8` | FINALIZED | 3/5 agree |

### Adversarial cases (all must fail)

- Wrong salt on reveal (`lunch-vote:reveal-wrong-salt`): commitment mismatch, no write.
- Wrong option on reveal (`lunch-vote:reveal-wrong-option`): commitment mismatch, no write.
- Duplicate commitment (`lunch-vote:commit-duplicate`): one commitment per voter.
- Duplicate reveal (`lunch-vote:reveal-duplicate`): a revealed ballot cannot be revealed again.
- Late commit (`empty-vote:commit-late`): commit window already closed.
- Early finalize (`lunch-vote:finalize-early`): reveal deadline not passed.
- Late reveal (`lunch-vote:reveal-late`): reveal window already closed.
- Stranger cancel (`lunch-vote:cancel-stranger`): only the creator can cancel.
- Stranger reveal (`lunch-vote:reveal-stranger`): only the voter who committed can reveal, even with the salt.
- Commit after cancel (`cancel-vote:commit-after-cancel`): cancelled elections are terminal.
- Conflicting re-create (`lunch-vote:create-conflict`): an election id cannot be redefined.

## Reviewer fast path

1. Read `docs/mechanism.md` — the whole protocol, sender-binding table and worst-case spread (exactly zero).
2. Read `contracts/sealed_vote.py` — the deployed source.
3. Run `npm ci && npm test` — 28 local unit tests, including SHA-256 vectors against hashlib and validator hour disagreement.
4. Check the deployed code matches the source: run `npm run read` — it compares the on-chain code at `0xF68b58AEA5AE127b34917D49e9F830F51FEFB9C0` with `contracts/sealed_vote.py` (SHA-256 `7adcbfcfefccde42…`).
5. Run `npm run read` — re-checks every receipt, the deployed source and every finalized readback, read-only.
6. Run `python scripts/verify_proof.py` — replays every tally and commitment hash offline from `evidence/live.json`.

## Known limitations

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Supplementary case: late-reveal-vote (orphaned, salt lost)

- `late-reveal-vote` was created (commit deadline 2026-11-10T01:00:00Z,
  reveal deadline 2026-11-10T02:00:00Z) with one commitment, as the
  expired-reveal case: the voter was to reveal with the correct salt
  after the reveal deadline and the call was expected to fail on chain
  with `REVEAL_WINDOW_CLOSED`, then finalize to `NO_VOTES`.
- The first run of `scripts/late_reveal.mjs` completed the create and
  the commit (both FINALIZED) but was killed by a runtime restart
  while waiting for the reveal hour. The salt and the temporary
  account keys lived only in that process's memory, so they were lost
  with it; no copy exists on disk, in any document, or in the repo.
  Without the salt the commitment can never be revealed (any reveal
  fails the hash check with `COMMITMENT_MISMATCH` first).
- The orphaned election was therefore closed out on 2026-11-10 ~03:07
  UTC by an unrelated throwaway account (`lateFinalizer`) calling
  `finalize_tally`: FINALIZED, 3/5 agree, terminal readback TALLIED,
  outcome `NO_VOTES`, counts `[0, 0]`, zero revealed ballots. The
  election never held funds. The expired-reveal attempt itself was
  not completed for this election id; it is re-run under a fresh
  election id with fresh temporary accounts.
- The `created` snapshot recorded for this election in
  `evidence/live.json` is reconstructed from the pre-finalize chain
  readback with commitments emptied (at creation the election had no
  commitments); deadlines, options and owner are read from the chain.
  `scripts/verify_proof.py` cannot recompute this commitment's hash
  offline (salt lost) and says so explicitly; the tally and result
  hash are still checked.
