# Known limitations

- A hash hides, it does not encrypt. A short, guessable salt combined
  with a guessable option can be brute-forced. Salts must be 8–64
  characters; voters should use long random salts.
- Losing the salt, or misremembering the option, makes a commitment
  unrevealable forever. There is no recovery path by design.
- Deadlines have UTC-hour granularity. A call made within seconds of
  an hour boundary may fail consensus if leader and validators fetch
  different hour buckets; the call writes nothing and can be retried.
- The current UTC hour is fetched from timeapi.io. If that service is
  unreachable, commit / reveal / tally calls fail before any write
  and can be retried later; the election stays OPEN. The time source
  supplies only the phase (which hour it is), never any ballot or
  business fact.
- At most 16 elections per creator and at most 64 commitments per
  election. These bounds keep tally loops small.
- An election created with deadlines already in the past accepts no
  commits; it can be cancelled or finalized as NO_VOTES.
- Unrevealed commitments count for nothing. A voter who never reveals
  has no effect on the result.
- All live evidence uses synthetic test elections with published
  test salts. The recorded ballots are test data, not real votes.
