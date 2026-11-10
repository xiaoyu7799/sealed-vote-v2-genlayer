# SealedVote protocol

## Finite model

One election contains 2–8 distinct options, each 1–60 characters,
with no `|` character. Deadlines are UTC hours written as
`YYYY-MM-DDTHH:00:00Z` (on the hour); the reveal deadline is strictly
later than the commit deadline. At most 16 elections per creator and
at most 64 commitments per election.

A commitment is a 64-character lowercase hex string: the SHA-256 of
`salt + "|" + option`. Salts are 8–64 printable ASCII characters with
no `|`. Because `|` is forbidden inside salts and inside options, the
concatenation is injective: no two different (salt, option) pairs
produce the same preimage string, so a commitment binds exactly one
salt and one option.

## Phases

Phases are decided by the current UTC hour, compared as ISO strings:

- commit: current hour `<=` commit deadline.
- reveal: commit deadline `<` current hour `<=` reveal deadline.
- tally: current hour `>` reveal deadline.

The current UTC hour comes from
`https://timeapi.io/api/Time/current/zone?timeZone=UTC`, fetched
independently by the leader and by every validator. A transaction
proceeds only if all of them agree on the hour exactly. A fetch
failure or a disagreement raises before any write, so the election
stays OPEN and the call can be retried. Comparing at hour
granularity means there is no sub-hour ambiguity: a commit in the
last minute of the commit-deadline hour is valid, a commit in the
first minute of the next hour is not.

## State

`OPEN -> TALLIED | CANCELLED`. There is no other state. A TALLIED or
CANCELLED election is terminal: no further commits, reveals, cancels
or tallies are accepted. The tally result, once written, is never
overwritten.

Commitments are stored per voter address: one commitment per voter
per election, immutable once stored. A revealed commitment records
the option index; an unrevealed commitment counts for nothing.

## Tally (deterministic)

Counts are integer counts of revealed ballots per option, in option
order. The winner is the option with the highest count. On a tie the
earliest-listed tied option wins. With zero revealed ballots the
outcome is `NO_VOTES` with no winner. The three outcomes are
exhaustive: `DECIDED | TIED | NO_VOTES`.

The result hash binds protocol, owner, election id, options, counts,
outcome and winner index:
`SHA-256(canonical({protocol, owner, election_id, options, counts,
outcome, winner_index}))`.

## Who may call what

| Operation | Caller | Enforced how |
| --- | --- | --- |
| `create_election` | anyone; the caller becomes the creator | sender is recorded as owner |
| `commit_vote` | any voter, for their own ballot only | sender address is the voter key |
| `reveal_vote` | only the voter who made the commitment | sender must equal the commitment owner |
| `cancel_election` | only the creator, and only while zero ballots are revealed | sender must equal owner; `revealed_count == 0` |
| `finalize_tally` | anyone | the tally is a pure function of revealed ballots, so the caller cannot change the outcome |

A stranger calling `cancel_election` loads no election under their
own address and fails. A stranger calling `reveal_vote` has no
commitment under their address and fails — even if they know the
salt, because the commitment is keyed by the committer's address.

Creating an election with an id the caller already used fails with
`ID_ALREADY_USED` — there is no idempotent rebuild, even for an
identical definition. A duplicate create is rejected outright, so a
conflicting redefinition can never silently replace an election.

## Exits

Every non-terminal state has an exit. An OPEN election is cancelled
by its creator while no ballot is revealed, or tallied by anyone
after the reveal deadline. There are no payable functions, so no GEN
can be locked or swallowed by a failed call.

## Worst-case spread

There is no score, tolerance or threshold band anywhere in the
contract. The only nondeterministic input is the current UTC hour,
pinned by exact agreement between leader and validators. The tally
is an integer count with no rounding. Two leader outputs that both
pass validation therefore carry the same hour, the same commitments
and the same tally. The worst-case spread between two
validator-compatible leader outputs is exactly zero: no spread can
change the outcome, the winner, or any count.

Edge cases: an hour-boundary disagreement (leader fetches 20:59:58,
a validator 21:00:03) rejects the transaction with no write and is
retryable. A tie cannot produce two different outcomes: the tie rule
is a fixed function of the counts. An election created with deadlines
already in the past is harmless: its commit window is already
closed, it can be cancelled, or it finalizes as `NO_VOTES`.

## Consensus boundary

The leader and each validator independently fetch the current UTC
hour and compare the full hour string. Any difference rejects the
candidate. Commitment matching, vote counting, the winner and the
tie rule are deterministic code, identical for every validator.
No language model is involved anywhere in this contract.
