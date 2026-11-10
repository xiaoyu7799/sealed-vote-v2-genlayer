# SealedVote

Sealed commit-reveal voting with a deterministic tally on GenLayer Stable Studionet. Voters commit only a hash — SHA-256(salt + "|" + option) — and reveal later; the contract recomputes the hash itself and counts only revealed ballots. The winner, the tie rule and the no-votes outcome are pure functions of the revealed ballots. No language model, no external evidence, no funds move.

## Run the local checks

```sh
npm ci
npm test
```

Python 3.12+ and Node.js 22+ are supported. Local unit tests use an explicit SDK substitute, including validator disagreement on the current hour. They do not establish network consensus.

`npm run live` deploys and runs the full staged election cycle on Stable Studionet (it waits for the UTC hour boundaries, about 1.5 hours). `npm run read` rechecks the recorded receipts, deployed source and finalized readbacks without sending a transaction. `python scripts/verify_proof.py` independently replays every tally and commitment hash offline.

## Use the contract

Deploy the complete `contracts/sealed_vote.py` file with **no constructor arguments** on **Stable Studionet 61999**, RPC `https://studio.genlayer.com/api`. Use Normal / Full Consensus; `leaderOnly` must be false. No funds, tokens, transfers or external paid API keys are needed.

Deadlines are UTC hours, written as `YYYY-MM-DDTHH:00:00Z` (on the hour). The current hour is fetched from timeapi.io by leader and validators, which must agree exactly.

1. Call `create_election("lunch-vote", "Lunch vote", '["Noodles", "Rice"]', "2026-11-09T21:00:00Z", "2026-11-09T22:00:00Z")`. The caller becomes the creator.
2. While the current UTC hour is at most the commit deadline, each voter calls `commit_vote(creator_address, "lunch-vote", commitment)` where `commitment` is the hex SHA-256 of `salt + "|" + option`. Keep the salt secret and safe — losing it makes the vote unrevealable.
3. While the current UTC hour is after the commit deadline and at most the reveal deadline, each voter calls `reveal_vote(creator_address, "lunch-vote", salt, option)`. Only the voter who committed can reveal, and the contract recomputes the hash before writing anything.
4. After the reveal deadline, anyone calls `finalize_tally(creator_address, "lunch-vote")`. Read `get_election(creator_address, "lunch-vote")` from finalized state and inspect `result`: `outcome` is `DECIDED`, `TIED` (winner is the earliest-listed tied option) or `NO_VOTES`, with integer `counts` and a `result_hash`.

The creator may call `cancel_election("lunch-vote")`, but only while no ballot has been revealed. A cancelled or tallied election is terminal.

## Interface

| Method | Arguments | Effect |
| --- | --- | --- |
| `create_election` | election_id, title, options JSON, commit_deadline, reveal_deadline | Creator-scoped registration; at most 16 elections per creator |
| `commit_vote` | creator, election_id, commitment hash | One immutable commitment per voter; commit window only |
| `reveal_vote` | creator, election_id, salt, option | Sender-bound reveal; hash recomputed and compared before any write |
| `cancel_election` | election_id | Creator-only, only while zero ballots are revealed |
| `finalize_tally` | creator, election_id | Anyone, after the reveal deadline; deterministic tally, terminal |
| `get_election` | creator, election_id | JSON string or empty string when absent |
| `get_result` | creator, election_id | Tally JSON or empty string before tally |
| `get_protocol` | none | Version identifier `sealed-vote-1` |

[Mechanism](docs/mechanism.md) · [Known limitations](KNOWN_LIMITATIONS.md) · [Network evidence](EVIDENCE.md)
