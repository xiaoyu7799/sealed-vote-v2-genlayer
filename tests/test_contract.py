"""Local tests for SealedVote.

The genlayer SDK is mocked: the contract module is loaded with a fake
`genlayer` module providing gl.Contract, gl.public, gl.message, gl.vm
and gl.nondet. The nondet time fetch is driven by a controllable mock
UTC hour so every phase window can be exercised locally, including
validator disagreement on the current hour.

SHA-256 vectors are checked against the standard library hashlib:
the contract must never depend on hashlib being present in GenVM.
These tests do not establish network consensus.
"""
import hashlib
import importlib.util
import json
import sys
import types
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# --- fake genlayer SDK -------------------------------------------------------


class Return:
    def __init__(self, value):
        self.calldata = value


class UserError(Exception):
    pass


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body


class Storage(dict):
    @classmethod
    def __class_getitem__(cls, _):
        return cls


def identity(f):
    return f


MOCK_HOUR = {"value": "2026-11-09T21:00:00Z"}
HOUR_SEQUENCE = []  # when non-empty, web.request pops hours from here
FETCH_SHOULD_FAIL = {"value": False}


def mock_web_request(url, method="GET"):
    assert url == "https://timeapi.io/api/Time/current/zone?timeZone=UTC"
    if FETCH_SHOULD_FAIL["value"]:
        raise Exception("network down")
    if HOUR_SEQUENCE:
        hour = HOUR_SEQUENCE.pop(0)
    else:
        hour = MOCK_HOUR["value"]
    body = json.dumps({"dateTime": hour[:13] + ":24:37.4466184"}).encode()
    return FakeResponse(200, body)


def mock_run_nondet_unsafe(fn, validate):
    try:
        result = fn()
    except UserError as err:
        if validate(err):
            raise err
        raise Exception("CONSENSUS_REJECTED")
    if not validate(Return(result)):
        raise Exception("CONSENSUS_REJECTED")
    return result


gl = types.SimpleNamespace(
    Contract=object,
    public=types.SimpleNamespace(view=identity, write=identity),
    message=types.SimpleNamespace(sender_address="0x" + "1" * 40),
    vm=types.SimpleNamespace(Return=Return, UserError=UserError,
                             run_nondet_unsafe=mock_run_nondet_unsafe),
    nondet=types.SimpleNamespace(web=types.SimpleNamespace(request=mock_web_request)),
)
sdk = types.ModuleType("genlayer")
sdk.gl, sdk.TreeMap, sdk.u32 = gl, Storage, int
sys.modules["genlayer"] = sdk

spec = importlib.util.spec_from_file_location(
    "sealed_vote", ROOT / "contracts" / "sealed_vote.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

CREATOR = "0x" + "a" * 40
V1 = "0x" + "1" * 40
V2 = "0x" + "2" * 40
V3 = "0x" + "3" * 40
V4 = "0x" + "4" * 40
STRANGER = "0x" + "9" * 40
COMMIT_DL = "2026-11-09T21:00:00Z"
REVEAL_DL = "2026-11-09T22:00:00Z"


def commit_hash(salt, option):
    return hashlib.sha256((salt + "|" + option).encode()).hexdigest()


def set_sender(addr):
    gl.message.sender_address = addr


class ContractTests(unittest.TestCase):
    def setUp(self):
        MOCK_HOUR["value"] = "2026-11-09T21:00:00Z"
        HOUR_SEQUENCE.clear()
        FETCH_SHOULD_FAIL["value"] = False
        set_sender(CREATOR)
        self.obj = c.SealedVote()
        self.obj.elections, self.obj.counts = {}, {}

    # -- helpers -------------------------------------------------------------
    def create(self, eid="e1", options=("Alpha", "Beta"),
               commit_dl=COMMIT_DL, reveal_dl=REVEAL_DL):
        return self.obj.create_election(
            eid, "Best option?", json.dumps(list(options)), commit_dl, reveal_dl)

    def election(self, eid="e1", creator=CREATOR):
        return json.loads(self.obj.get_election(creator, eid))

    def commit(self, voter, eid="e1", salt="salt-1111", option="Alpha",
               creator=CREATOR):
        set_sender(voter)
        return self.obj.commit_vote(creator, eid, commit_hash(salt, option))

    def reveal(self, voter, eid="e1", salt="salt-1111", option="Alpha",
               creator=CREATOR):
        set_sender(voter)
        return self.obj.reveal_vote(creator, eid, salt, option)

    def finalize(self, eid="e1", creator=CREATOR, sender=STRANGER):
        set_sender(sender)
        return json.loads(self.obj.finalize_tally(creator, eid))

    # -- SHA-256 vectors ------------------------------------------------------
    def test_sha256_vectors_match_hashlib(self):
        vectors = [
            "",
            "abc",
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "a" * 64,
            "The quick brown fox jumps over the lazy dog",
            "salt-1111|Alpha",
            "s3cr3t-salt-value|Beta",
            "x" * 1000,
            "héllo wörld — ünïcode ✓",
        ]
        for v in vectors:
            self.assertEqual(c.pure_sha256_hex(v),
                             hashlib.sha256(v.encode()).hexdigest(), repr(v))
        self.assertEqual(c.pure_sha256_hex("a" * 1000000),
                         hashlib.sha256(b"a" * 1000000).hexdigest())

    # -- creation ---------------------------------------------------------------
    def test_create_registers_open_election(self):
        key = self.create()
        self.assertEqual(key, CREATOR.lower() + ":e1")
        self.assertEqual(self.obj.counts[CREATOR.lower()], 1)
        el = self.election()
        self.assertEqual(el["state"], "OPEN")
        self.assertEqual(el["options"], ["Alpha", "Beta"])
        self.assertEqual(el["commit_deadline"], COMMIT_DL)
        self.assertEqual(el["reveal_deadline"], REVEAL_DL)
        self.assertEqual(el["result"], None)
        self.assertEqual(self.obj.get_result(CREATOR, "e1"), "")
        self.assertEqual(self.obj.get_protocol(), "sealed-vote-1")

    def test_create_same_id_twice_fails(self):
        self.create()
        set_sender(CREATOR)
        with self.assertRaisesRegex(UserError, "ID_ALREADY_USED"):
            self.obj.create_election("e1", "Different?", '["Alpha", "Beta"]',
                                     COMMIT_DL, REVEAL_DL)
        with self.assertRaisesRegex(UserError, "ID_ALREADY_USED"):
            self.create()

    def test_create_validation(self):
        set_sender(CREATOR)
        bad = [
            ("", ["Alpha", "Beta"], COMMIT_DL, REVEAL_DL),
            ("Bad ID", ["Alpha", "Beta"], COMMIT_DL, REVEAL_DL),
            ("e2", ["Alpha"], COMMIT_DL, REVEAL_DL),
            ("e2", ["Alpha", "Alpha"], COMMIT_DL, REVEAL_DL),
            ("e2", ["Alpha", "A|B"], COMMIT_DL, REVEAL_DL),
            ("e2", ["Alpha", "Beta"], "2026-11-09T21:30:00Z", REVEAL_DL),
            ("e2", ["Alpha", "Beta"], "2026-11-09 21:00:00Z", REVEAL_DL),
            ("e2", ["Alpha", "Beta"], REVEAL_DL, COMMIT_DL),
            ("e2", ["Alpha", "Beta"], COMMIT_DL, COMMIT_DL),
            ("e2", ["Alpha", "Beta"], "2026-02-30T21:00:00Z", REVEAL_DL),
        ]
        for eid, opts, cdl, rdl in bad:
            with self.assertRaises(UserError, msg=(eid, opts, cdl, rdl)):
                self.obj.create_election(eid, "T?", json.dumps(opts), cdl, rdl)

    def test_creator_limit(self):
        for i in range(16):
            self.create(eid=f"e{i}")
        with self.assertRaisesRegex(UserError, "CREATOR_LIMIT"):
            self.create(eid="e16")

    # -- happy paths ------------------------------------------------------------
    def test_normal_election_winner(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        self.commit(V2, salt="salt-2222", option="Alpha")
        self.commit(V3, salt="salt-3333", option="Beta")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        self.reveal(V1, salt="salt-1111", option="Alpha")
        self.reveal(V2, salt="salt-2222", option="Alpha")
        self.reveal(V3, salt="salt-3333", option="Beta")
        el = self.election()
        self.assertEqual(el["revealed_count"], 3)
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        result = self.finalize()
        self.assertEqual(result["outcome"], "DECIDED")
        self.assertEqual(result["counts"], [2, 1])
        self.assertEqual(result["winner"], "Alpha")
        self.assertEqual(result["winner_index"], 0)
        self.assertEqual(result["total_revealed"], 3)
        self.assertEqual(result["tied_indices"], [])
        self.assertEqual(self.election()["state"], "TALLIED")
        # result hash recomputes independently (hashlib, not contract code)
        expect = hashlib.sha256(json.dumps(
            {"protocol": "sealed-vote-1", "owner": CREATOR.lower(),
             "election_id": "e1", "options": ["Alpha", "Beta"],
             "counts": [2, 1], "outcome": "DECIDED", "winner_index": 0},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()).hexdigest()
        self.assertEqual(result["result_hash"], expect)
        self.assertEqual(json.loads(self.obj.get_result(CREATOR, "e1")), result)
        # terminal: no second tally, no more commits/reveals
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        with self.assertRaisesRegex(UserError, "NOT_OPEN"):
            self.finalize()
        with self.assertRaisesRegex(UserError, "NOT_OPEN"):
            self.commit(V4, salt="salt-4444", option="Beta")

    def test_tie_uses_earliest_listed_option(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        self.commit(V2, salt="salt-2222", option="Beta")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        self.reveal(V1, salt="salt-1111", option="Alpha")
        self.reveal(V2, salt="salt-2222", option="Beta")
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        result = self.finalize()
        self.assertEqual(result["outcome"], "TIED")
        self.assertEqual(result["counts"], [1, 1])
        self.assertEqual(result["winner"], "Alpha")
        self.assertEqual(result["winner_index"], 0)
        self.assertEqual(result["tied_indices"], [0, 1])

    def test_no_votes_finalizes_no_votes(self):
        self.create()
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        result = self.finalize()
        self.assertEqual(result["outcome"], "NO_VOTES")
        self.assertEqual(result["counts"], [0, 0])
        self.assertIsNone(result["winner"])
        self.assertIsNone(result["winner_index"])
        self.assertEqual(result["total_revealed"], 0)

    def test_unrevealed_commitments_do_not_count(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        self.commit(V2, salt="salt-2222", option="Beta")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        self.reveal(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        result = self.finalize()
        self.assertEqual(result["counts"], [1, 0])
        self.assertEqual(result["total_revealed"], 1)

    def test_finalize_by_anyone(self):
        # finalize is a deterministic pure function; the caller cannot
        # change the outcome, so any address may trigger it.
        self.create()
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        self.assertEqual(self.finalize(sender=V4)["outcome"], "NO_VOTES")

    def test_cancel_by_creator_before_any_reveal(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        set_sender(CREATOR)
        self.obj.cancel_election("e1")
        el = self.election()
        self.assertEqual(el["state"], "CANCELLED")
        with self.assertRaisesRegex(UserError, "NOT_OPEN"):
            self.commit(V2, salt="salt-2222", option="Beta")

    # -- adversarial / failure paths -------------------------------------------
    def test_wrong_salt_reveal_fails_and_writes_nothing(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        before = deepcopy(self.obj.elections)
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "COMMITMENT_MISMATCH"):
            self.reveal(V1, salt="salt-9999", option="Alpha")
        self.assertEqual(before, self.obj.elections)

    def test_wrong_option_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "COMMITMENT_MISMATCH"):
            self.reveal(V1, salt="salt-1111", option="Beta")

    def test_duplicate_commitment_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        with self.assertRaisesRegex(UserError, "DUPLICATE_COMMITMENT"):
            self.commit(V1, salt="salt-2222", option="Beta")
        self.assertEqual(len(self.election()["commitments"]), 1)

    def test_duplicate_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        self.reveal(V1, salt="salt-1111", option="Alpha")
        with self.assertRaisesRegex(UserError, "ALREADY_REVEALED"):
            self.reveal(V1, salt="salt-1111", option="Alpha")
        self.assertEqual(self.election()["revealed_count"], 1)

    def test_late_commit_fails(self):
        self.create()
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "COMMIT_WINDOW_CLOSED"):
            self.commit(V1, salt="salt-1111", option="Alpha")
        self.assertEqual(self.election()["commitments"], {})

    def test_early_finalize_fails(self):
        self.create()
        MOCK_HOUR["value"] = "2026-11-09T21:00:00Z"
        with self.assertRaisesRegex(UserError, "TALLY_TOO_EARLY"):
            self.finalize()
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "TALLY_TOO_EARLY"):
            self.finalize()
        self.assertEqual(self.election()["state"], "OPEN")

    def test_late_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T23:00:00Z"
        with self.assertRaisesRegex(UserError, "REVEAL_WINDOW_CLOSED"):
            self.reveal(V1, salt="salt-1111", option="Alpha")
        self.assertFalse(self.election()["commitments"][V1.lower()]["revealed"])

    def test_early_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T21:00:00Z"
        with self.assertRaisesRegex(UserError, "REVEAL_WINDOW_CLOSED"):
            self.reveal(V1, salt="salt-1111", option="Alpha")

    def test_stranger_cannot_cancel(self):
        self.create()
        set_sender(STRANGER)
        with self.assertRaisesRegex(UserError, "NOT_FOUND"):
            self.obj.cancel_election("e1")
        self.assertEqual(self.election()["state"], "OPEN")

    def test_stranger_cannot_reveal(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        set_sender(STRANGER)
        with self.assertRaisesRegex(UserError, "NOT_COMMITTED"):
            self.obj.reveal_vote(CREATOR, "e1", "salt-1111", "Alpha")
        self.assertEqual(self.election()["revealed_count"], 0)

    def test_cancel_after_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        self.reveal(V1, salt="salt-1111", option="Alpha")
        set_sender(CREATOR)
        with self.assertRaisesRegex(UserError, "ALREADY_REVEALED_VOTES"):
            self.obj.cancel_election("e1")
        self.assertEqual(self.election()["state"], "OPEN")

    def test_reveal_without_commit_fails(self):
        self.create()
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "NOT_COMMITTED"):
            self.reveal(V1, salt="salt-1111", option="Alpha")

    def test_malformed_commitment_fails(self):
        self.create()
        set_sender(V1)
        for bad in ["", "zz" * 32, "A" * 64, "a" * 63]:
            with self.assertRaisesRegex(UserError, "COMMITMENT_FORMAT", msg=bad):
                self.obj.commit_vote(CREATOR, "e1", bad)

    def test_short_salt_reveal_fails(self):
        self.create()
        self.commit(V1, salt="salt-1111", option="Alpha")
        MOCK_HOUR["value"] = "2026-11-09T22:00:00Z"
        with self.assertRaisesRegex(UserError, "SALT_BOUNDS"):
            self.reveal(V1, salt="short", option="Alpha")

    # -- consensus boundary ------------------------------------------------------
    def test_hour_disagreement_rejects_with_no_write(self):
        self.create()
        # leader fetches 21:00, validator fetches 22:00
        HOUR_SEQUENCE.extend(["2026-11-09T21:00:00Z",
                              "2026-11-09T22:00:00Z"])
        with self.assertRaisesRegex(Exception, "CONSENSUS_REJECTED"):
            self.commit(V1, salt="salt-1111", option="Alpha")
        self.assertEqual(self.election()["commitments"], {})

    def test_time_fetch_failure_rejects_with_no_write(self):
        self.create()
        FETCH_SHOULD_FAIL["value"] = True
        with self.assertRaisesRegex(UserError, "EXTERNAL"):
            self.commit(V1, salt="salt-1111", option="Alpha")
        self.assertEqual(self.election()["commitments"], {})

    def test_past_deadline_election_finalizes_no_votes(self):
        self.create(eid="old", commit_dl="2026-11-09T19:00:00Z",
                   reveal_dl="2026-11-09T20:00:00Z")
        MOCK_HOUR["value"] = "2026-11-09T21:00:00Z"
        with self.assertRaisesRegex(UserError, "COMMIT_WINDOW_CLOSED"):
            self.commit(V1, eid="old", salt="salt-1111", option="Alpha")
        result = self.finalize(eid="old")
        self.assertEqual(result["outcome"], "NO_VOTES")


if __name__ == "__main__":
    unittest.main()
