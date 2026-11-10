"""Validate captured SealedVote tallies offline, without the network.

Recomputes every commitment hash from the recorded test salts and
options (hashlib, not the contract's pure-Python SHA-256), replays
the deterministic tally from the recorded revealed ballots, and
recomputes every result hash. Run after the live run:
    python scripts/verify_proof.py
"""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
journal = json.loads((root / "evidence" / "live.json").read_text())

SALTS = {
    "voterA": "voter-a-salt-2026", "voterB": "voter-b-salt-2026",
    "voterC": "voter-c-salt-2026", "voterD": "voter-d-salt-2026",
    "voterE": "voter-e-salt-2026", "voterG": "voter-g-salt-2026",
    "voterH": "voter-h-salt-2026",
}
# option each test voter committed to, per election
VOTES = {
    "lunch-vote": {"voterA": "Noodles", "voterB": "Noodles",
                   "voterC": "Rice", "voterG": "Rice"},
    "mascot-vote": {"voterD": "Mochi", "voterE": "Pixel"},
    "cancel-vote": {"voterH": "Yes"},
}


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def sha(value):
    return hashlib.sha256(canon(value).encode()).hexdigest()


accounts = journal["accounts"]
by_address = {addr.lower(): label for label, addr in accounts.items()}

for rec in journal["elections"]:
    final = rec.get("final")
    assert final, rec["id"] + " has no final readback"
    election_id = rec["id"]
    # every stored commitment hash must equal SHA-256(salt|option)
    for addr, entry in final["commitments"].items():
        label = by_address.get(addr.lower())
        assert label, "unknown voter " + addr
        option = VOTES[election_id][label]
        expect = hashlib.sha256(
            (SALTS[label] + "|" + option).encode()).hexdigest()
        assert entry["commitment"] == expect, election_id + " " + label
        if entry["revealed"]:
            # the revealed ballot must be the option that was committed
            assert final["options"][entry["option_index"]] == option, \
                election_id + " " + label + " revealed a different option"
    if final["state"] != "TALLIED":
        print(election_id, final["state"], "commitment hashes checked")
        continue
    result = final["result"]
    counts = [0] * len(final["options"])
    total = 0
    for entry in final["commitments"].values():
        if entry["revealed"]:
            counts[entry["option_index"]] += 1
            total += 1
    assert result["counts"] == counts
    assert result["total_revealed"] == total
    best = max(counts) if counts else 0
    tied = [i for i, c in enumerate(counts) if c == best]
    outcome = "NO_VOTES" if total == 0 else "TIED" if len(tied) > 1 else "DECIDED"
    assert result["outcome"] == outcome
    assert result["winner_index"] == (None if total == 0 else tied[0])
    assert result["winner"] == (None if total == 0
                                else final["options"][tied[0]])
    assert result["tied_indices"] == ([] if total == 0 or len(tied) == 1 else tied)
    expect_hash = sha({"protocol": "sealed-vote-1", "owner": final["owner"],
                       "election_id": election_id,
                       "options": final["options"], "counts": counts,
                       "outcome": outcome,
                       "winner_index": result["winner_index"]})
    assert result["result_hash"] == expect_hash
    assert final["result_hash"] == expect_hash
    print(election_id, outcome, counts, "winner:", result["winner"],
          "| tally + commitment + result hashes checked independently")
print("ALL CERTIFICATES CHECKED")
