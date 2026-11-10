# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""SealedVote: sealed commit-reveal voting with a deterministic tally.

Problem
-------
A vote must stay secret while it is being cast and yet be countable
afterwards, with no one — not the election creator, not a voter, not a
validator — able to invent a vote, change a vote, or tally a different
result from the revealed ballots.

What this contract does
-----------------------
1. Anyone creates an election: a title, 2-8 options, a commit deadline
   and a reveal deadline. Both deadlines are UTC hours, written as
   "YYYY-MM-DDTHH:00:00Z" (on the hour), with the reveal deadline
   strictly later than the commit deadline.
2. During the commit window (current UTC hour <= commit deadline) a
   voter commits exactly one vote by submitting only its hash:
   SHA-256(salt + "|" + option). The salt and the option never leave
   the voter's machine at this point; the chain stores the hash only.
   One commitment per voter per election; a second commitment fails.
3. During the reveal window (commit deadline < current UTC hour <=
   reveal deadline) the voter reveals by submitting the salt and the
   option. The contract recomputes SHA-256(salt + "|" + option) with
   its own pure-Python implementation and compares it with the stored
   commitment. A mismatch raises before any write. Only the voter who
   made the commitment can reveal it.
4. After the reveal deadline (current UTC hour > reveal deadline)
   anyone may finalize the tally. The tally is a deterministic count
   of the revealed ballots: the option with the most votes wins; on a
   tie the earliest-listed tied option wins (deterministic tie rule);
   with zero revealed ballots the outcome is NO_VOTES. The result is
   recorded immutably and can never be overwritten.
5. The creator may cancel the election, but only while no ballot has
   been revealed yet. Once any ballot is revealed the election must
   run to a tally, so the creator cannot suppress an unfavourable
   result. A cancelled election is terminal.

Time
----
The current UTC hour comes from
https://timeapi.io/api/Time/current/zone?timeZone=UTC, fetched
independently by the leader and by every validator. A transaction
proceeds only if all of them agree on the hour exactly (string
equality of the hour bucket). If the time source is unreachable, or
the fetched hours disagree, the call raises before any write, the
election stays OPEN, and the call can be retried. Deadlines are
compared at UTC-hour granularity, so there is no sub-hour ambiguity:
a commit in the last minute of the commit-deadline hour is valid; a
commit in the first minute of the next hour is not.

Cryptography
------------
SHA-256 is implemented in pure Python inside this contract; no
assumption is made about hashlib being available in GenVM. Before
deployment it was checked locally against the standard-library
implementation on the standard test vectors (see tests/). The
commitment preimage is salt + "|" + option. The "|" separator is
forbidden inside salts and inside options, which makes the
concatenation injective: no two different (salt, option) pairs can
produce the same preimage string. Salts must be 8-64 characters.

Honest limits
-------------
A hash hides, it does not encrypt: a short guessable salt combined
with a guessable option can be brute-forced. Losing the salt (or
misremembering the option) makes a commitment unrevealable forever;
callers must warn voters to keep the salt. The tally counts only
revealed ballots; unrevealed commitments count for nothing.

Money
-----
This contract has no payable functions. No GEN ever flows in or out,
so a failed call cannot swallow funds and no balance can get stuck.

Consensus design
----------------
The only nondeterministic input is the current UTC hour, and it is
pinned by EXACT agreement, not by a tolerance band. Everything else
— commitment matching, vote counting, the winner and the tie rule —
is deterministic code that runs identically for every validator. Two
leader outputs that both pass validation therefore carry the same
hour, the same commitments and the same tally. The worst-case spread
between two validator-compatible leader outputs is exactly zero; see
docs/mechanism.md for the calculation.
"""

import json

from genlayer import *

PROTOCOL_VERSION = "sealed-vote-1"
TIME_SOURCE_URL = "https://timeapi.io/api/Time/current/zone?timeZone=UTC"
MAX_ELECTIONS_PER_CREATOR = 16
MAX_COMMITMENTS_PER_ELECTION = 64
MAX_OPTIONS = 8
MIN_OPTIONS = 2
MAX_TITLE_LENGTH = 80
MAX_OPTION_LENGTH = 60
MAX_ELECTION_ID_LENGTH = 48
MIN_SALT_LENGTH = 8
MAX_SALT_LENGTH = 64


# ======================================================================
# Pure-Python SHA-256 (no dependency on unverified stdlib hashlib in GenVM).
# Checked locally against hashlib test vectors before deployment.
# ======================================================================

_SHA256_ROUND_CONSTANTS = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
    0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
    0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
    0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
    0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
    0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
    0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
    0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
    0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
]


def _rotate_right_32(value: int, bits: int) -> int:
    return ((value >> bits) | (value << (32 - bits))) & 0xFFFFFFFF


def pure_sha256_hex(message_text: str) -> str:
    data = bytearray(message_text.encode("utf-8"))
    bit_length = len(data) * 8
    data.append(0x80)
    while (len(data) % 64) != 56:
        data.append(0x00)
    for shift in range(7, -1, -1):
        data.append((bit_length >> (shift * 8)) & 0xFF)
    digest_state = [
        0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
        0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
    ]
    for block_start in range(0, len(data), 64):
        words = [0] * 64
        for index in range(16):
            pos = block_start + index * 4
            words[index] = (
                (data[pos] << 24)
                | (data[pos + 1] << 16)
                | (data[pos + 2] << 8)
                | data[pos + 3]
            )
        for index in range(16, 64):
            small0 = (
                _rotate_right_32(words[index - 15], 7)
                ^ _rotate_right_32(words[index - 15], 18)
                ^ (words[index - 15] >> 3)
            )
            small1 = (
                _rotate_right_32(words[index - 2], 17)
                ^ _rotate_right_32(words[index - 2], 19)
                ^ (words[index - 2] >> 10)
            )
            words[index] = (
                words[index - 16] + small0 + words[index - 7] + small1
            ) & 0xFFFFFFFF
        a, b, c, d, e, f, g, h = digest_state
        for index in range(64):
            big1 = (
                _rotate_right_32(e, 6)
                ^ _rotate_right_32(e, 11)
                ^ _rotate_right_32(e, 25)
            )
            choose = (e & f) ^ ((~e & 0xFFFFFFFF) & g)
            temp1 = (
                h + big1 + choose + _SHA256_ROUND_CONSTANTS[index] + words[index]
            ) & 0xFFFFFFFF
            big0 = (
                _rotate_right_32(a, 2)
                ^ _rotate_right_32(a, 13)
                ^ _rotate_right_32(a, 22)
            )
            majority = (a & b) ^ (a & c) ^ (b & c)
            temp2 = (big0 + majority) & 0xFFFFFFFF
            h, g, f, e, d, c, b, a = (
                g, f, e, (d + temp1) & 0xFFFFFFFF, c, b, a,
                (temp1 + temp2) & 0xFFFFFFFF,
            )
        new_values = [a, b, c, d, e, f, g, h]
        digest_state = [
            (digest_state[idx] + new_values[idx]) & 0xFFFFFFFF
            for idx in range(8)
        ]
    hex_digits = "0123456789abcdef"
    out = []
    for word in digest_state:
        for shift in (28, 24, 20, 16, 12, 8, 4, 0):
            out.append(hex_digits[(word >> shift) & 0xF])
    return "".join(out)


# ======================================================================
# Deterministic helpers (pure functions: no nondet, no floats)
# ======================================================================


def _fail_unless(condition, message):
    if not condition:
        raise gl.vm.UserError(message)


def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _digest(value):
    return pure_sha256_hex(_canonical_json(value))


def _load_json_packed(text):
    if type(text) is dict:
        return text
    _fail_unless(type(text) is str, "JSON_REQUIRED")

    def _no_duplicate_keys(pairs):
        result = {}
        for key, val in pairs:
            _fail_unless(key not in result, "DUPLICATE_KEY")
            result[key] = val
        return result

    return json.loads(text, object_pairs_hook=_no_duplicate_keys)


def _is_digit_char(ch: str) -> bool:
    return "0" <= ch <= "9"


def _valid_hour_format(text: str) -> bool:
    # "YYYY-MM-DDTHH:00:00Z", exactly 20 chars, on the hour.
    if not isinstance(text, str) or len(text) != 20:
        return False
    if text[4] != "-" or text[7] != "-" or text[10] != "T":
        return False
    if text[13] != ":" or text[16] != ":" or text[19] != "Z":
        return False
    for i in (0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18):
        if not _is_digit_char(text[i]):
            return False
    if text[14:16] != "00" or text[17:19] != "00":
        return False
    year = int(text[0:4])
    month = int(text[5:7])
    day = int(text[8:10])
    hour = int(text[11:13])
    if month < 1 or month > 12 or hour < 0 or hour > 23:
        return False
    leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
    days_in_month = [31, 29 if leap else 28, 31, 30, 31, 30,
                     31, 31, 30, 31, 30, 31]
    if day < 1 or day > days_in_month[month - 1]:
        return False
    return True


def _valid_election_id(election_id) -> bool:
    if not isinstance(election_id, str):
        return False
    if len(election_id) < 1 or len(election_id) > MAX_ELECTION_ID_LENGTH:
        return False
    for ch in election_id:
        if not (("a" <= ch <= "z") or ("0" <= ch <= "9")
                or ch == "-" or ch == "_"):
            return False
    return True


def _valid_commitment(commitment) -> bool:
    if not isinstance(commitment, str) or len(commitment) != 64:
        return False
    for ch in commitment:
        if not (("0" <= ch <= "9") or ("a" <= ch <= "f")):
            return False
    return True


def _valid_salt(salt) -> bool:
    if not isinstance(salt, str):
        return False
    if len(salt) < MIN_SALT_LENGTH or len(salt) > MAX_SALT_LENGTH:
        return False
    if "|" in salt:
        return False
    for ch in salt:
        if ord(ch) < 32 or ord(ch) > 126:
            return False
    return True


def _count_revealed(options, commitments):
    """Deterministic tally over revealed ballots. Pure function.

    Returns (counts, outcome, winner_index, tied_indices).
    Tie rule: the earliest-listed option among those tied on the
    highest count wins. Zero revealed ballots -> NO_VOTES.
    """
    counts = [0] * len(options)
    total = 0
    for voter in commitments:
        entry = commitments[voter]
        if entry["revealed"]:
            counts[entry["option_index"]] += 1
            total += 1
    if total == 0:
        return counts, "NO_VOTES", None, []
    best = counts[0]
    for value in counts:
        if value > best:
            best = value
    tied = []
    for index in range(len(counts)):
        if counts[index] == best:
            tied.append(index)
    if len(tied) == 1:
        return counts, "DECIDED", tied[0], []
    return counts, "TIED", tied[0], tied


# ======================================================================
# Current UTC hour (the only nondeterministic input, exact agreement)
# ======================================================================


def _fetch_current_hour() -> str:
    def fetch() -> str:
        try:
            response = gl.nondet.web.request(TIME_SOURCE_URL, method="GET")
        except Exception:
            raise gl.vm.UserError("EXTERNAL: time_api_fetch_failed")
        if getattr(response, "status", 200) != 200:
            raise gl.vm.UserError("EXTERNAL: time_api_status")
        body = response.body
        text = body.decode("utf-8") if isinstance(body, bytes) else str(body)
        try:
            data = json.loads(text)
            current = str(data["dateTime"])[:13] + ":00:00Z"
        except Exception:
            raise gl.vm.UserError("EXTERNAL: time_api_bad_json")
        if not _valid_hour_format(current):
            raise gl.vm.UserError("EXTERNAL: time_api_bad_date")
        return current

    def validate(leader) -> bool:
        if isinstance(leader, gl.vm.UserError):
            try:
                fetch()
            except gl.vm.UserError:
                return True
            except Exception:
                return False
            return False
        if not isinstance(leader, gl.vm.Return):
            return False
        proposed = leader.calldata
        if not isinstance(proposed, str):
            return False
        try:
            own = fetch()
        except Exception:
            return False
        return proposed == own

    return gl.vm.run_nondet_unsafe(fetch, validate)


class SealedVote(gl.Contract):
    elections: TreeMap[str, str]
    counts: TreeMap[str, u32]

    def __init__(self):
        pass

    @gl.public.view
    def get_protocol(self) -> str:
        return PROTOCOL_VERSION

    @gl.public.view
    def get_election(self, creator: str, election_id: str) -> str:
        return self.elections.get(str(creator).lower() + ":" + election_id, "")

    @gl.public.view
    def get_result(self, creator: str, election_id: str) -> str:
        raw = self.elections.get(str(creator).lower() + ":" + election_id, "")
        if not raw:
            return ""
        election = _load_json_packed(raw)
        result = election["result"]
        if result is None:
            return ""
        return _canonical_json(result)

    # -- writes ----------------------------------------------------------

    @gl.public.write
    def create_election(self, election_id: str, title: str, options_json: str,
                        commit_deadline: str, reveal_deadline: str) -> str:
        _fail_unless(_valid_election_id(election_id), "ID_INVALID")
        _fail_unless(isinstance(title, str)
                     and 0 < len(title.strip()) <= MAX_TITLE_LENGTH
                     and title == title.strip(), "TITLE_BOUNDS")
        _fail_unless(_valid_hour_format(commit_deadline),
                     "COMMIT_DEADLINE_FORMAT")
        _fail_unless(_valid_hour_format(reveal_deadline),
                     "REVEAL_DEADLINE_FORMAT")
        _fail_unless(reveal_deadline > commit_deadline,
                     "REVEAL_AFTER_COMMIT")
        try:
            options = json.loads(options_json)
        except Exception:
            raise gl.vm.UserError("OPTIONS_JSON")
        _fail_unless(type(options) is list
                     and MIN_OPTIONS <= len(options) <= MAX_OPTIONS,
                     "OPTION_COUNT")
        seen = {}
        for option in options:
            _fail_unless(isinstance(option, str)
                         and 0 < len(option.strip()) <= MAX_OPTION_LENGTH
                         and option == option.strip()
                         and "|" not in option, "OPTION_BOUNDS")
            _fail_unless(option not in seen, "OPTION_DUPLICATE")
            seen[option] = True
        creator = str(gl.message.sender_address).lower()
        key = creator + ":" + election_id
        previous = self.elections.get(key, "")
        _fail_unless(not previous, "ID_ALREADY_USED")
        count = self.counts.get(creator, 0)
        _fail_unless(count < MAX_ELECTIONS_PER_CREATOR, "CREATOR_LIMIT")
        self.elections[key] = _canonical_json({
            "protocol": PROTOCOL_VERSION, "owner": creator,
            "election_id": election_id,
            "title": title.strip(), "options": options,
            "commit_deadline": commit_deadline,
            "reveal_deadline": reveal_deadline,
            "state": "OPEN", "commitments": {}, "revealed_count": 0,
            "result": None, "result_hash": None,
        })
        self.counts[creator] = u32(count + 1)
        return key

    def _load_election(self, creator: str, election_id: str) -> dict:
        key = str(creator).lower() + ":" + election_id
        raw = self.elections.get(key, "")
        _fail_unless(bool(raw), "NOT_FOUND")
        return _load_json_packed(raw)

    def _save_election(self, election: dict):
        key = election["owner"] + ":" + election["election_id"]
        self.elections[key] = _canonical_json(election)

    @gl.public.write
    def commit_vote(self, creator: str, election_id: str,
                    commitment: str) -> str:
        election = self._load_election(creator, election_id)
        _fail_unless(election["state"] == "OPEN", "NOT_OPEN")
        _fail_unless(_valid_commitment(commitment), "COMMITMENT_FORMAT")
        voter = str(gl.message.sender_address).lower()
        _fail_unless(voter not in election["commitments"],
                     "DUPLICATE_COMMITMENT")
        _fail_unless(len(election["commitments"])
                     < MAX_COMMITMENTS_PER_ELECTION, "ELECTION_FULL")
        now = _fetch_current_hour()
        _fail_unless(now <= election["commit_deadline"],
                     "COMMIT_WINDOW_CLOSED")
        election["commitments"][voter] = {
            "commitment": commitment, "revealed": False,
            "option_index": None,
        }
        self._save_election(election)
        return _canonical_json({"election": election["election_id"],
                                "voter": voter,
                                "commitment": commitment,
                                "phase": "COMMITTED"})

    @gl.public.write
    def reveal_vote(self, creator: str, election_id: str,
                    salt: str, option: str) -> str:
        election = self._load_election(creator, election_id)
        _fail_unless(election["state"] == "OPEN", "NOT_OPEN")
        voter = str(gl.message.sender_address).lower()
        entry = election["commitments"].get(voter)
        _fail_unless(entry is not None, "NOT_COMMITTED")
        _fail_unless(entry["revealed"] is False, "ALREADY_REVEALED")
        _fail_unless(_valid_salt(salt), "SALT_BOUNDS")
        _fail_unless(option in election["options"], "OPTION_UNKNOWN")
        # The hash check runs before any nondet call and before any
        # write: a wrong salt or a wrong option fails here, always.
        recomputed = pure_sha256_hex(salt + "|" + option)
        _fail_unless(recomputed == entry["commitment"],
                     "COMMITMENT_MISMATCH")
        now = _fetch_current_hour()
        _fail_unless(election["commit_deadline"] < now
                     <= election["reveal_deadline"],
                     "REVEAL_WINDOW_CLOSED")
        entry["revealed"] = True
        entry["option_index"] = election["options"].index(option)
        election["revealed_count"] = int(election["revealed_count"]) + 1
        self._save_election(election)
        return _canonical_json({"election": election["election_id"],
                                "voter": voter,
                                "option": option,
                                "option_index": entry["option_index"],
                                "phase": "REVEALED"})

    @gl.public.write
    def cancel_election(self, election_id: str) -> str:
        creator = str(gl.message.sender_address).lower()
        election = self._load_election(creator, election_id)
        _fail_unless(election["state"] == "OPEN", "NOT_OPEN")
        _fail_unless(int(election["revealed_count"]) == 0,
                     "ALREADY_REVEALED_VOTES")
        election["state"] = "CANCELLED"
        self._save_election(election)
        return _canonical_json({"election": election["election_id"],
                                "state": "CANCELLED"})

    @gl.public.write
    def finalize_tally(self, creator: str, election_id: str) -> str:
        election = self._load_election(creator, election_id)
        _fail_unless(election["state"] == "OPEN", "NOT_OPEN")
        now = _fetch_current_hour()
        _fail_unless(now > election["reveal_deadline"], "TALLY_TOO_EARLY")
        counts, outcome, winner_index, tied = _count_revealed(
            election["options"], election["commitments"])
        result = {
            "protocol": PROTOCOL_VERSION, "owner": election["owner"],
            "election_id": election["election_id"],
            "options": election["options"], "counts": counts,
            "total_revealed": int(election["revealed_count"]),
            "outcome": outcome,
            "winner_index": winner_index,
            "winner": election["options"][winner_index]
            if winner_index is not None else None,
            "tied_indices": tied,
        }
        result["result_hash"] = _digest({
            "protocol": PROTOCOL_VERSION, "owner": election["owner"],
            "election_id": election["election_id"],
            "options": election["options"], "counts": counts,
            "outcome": outcome, "winner_index": winner_index})
        election["result"] = result
        election["result_hash"] = result["result_hash"]
        election["state"] = "TALLIED"
        self._save_election(election)
        return _canonical_json(result)
