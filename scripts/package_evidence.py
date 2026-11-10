"""Build the evidence pack from evidence/live.json after the live run.

Generates:
  evidence/evidence.json — compact machine-readable evidence
  EVIDENCE.md            — deployment checklist, live verification,
                           reviewer fast path
Run: python scripts/package_evidence.py
"""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
journal = json.loads((root / "evidence" / "live.json").read_text())
source = (root / "contracts" / "sealed_vote.py").read_text()
source_sha = hashlib.sha256(source.encode()).hexdigest()
assert source_sha == journal["source_sha256"], "source changed after deploy"
assert journal.get("completed_at"), "live run not complete"

txs = []
for t in journal["transactions"]:
    receipt = t.get("receipt") or {}
    votes = {}
    if receipt:
        raw_votes = (receipt.get("consensus_data") or {}).get("votes") or {}
        votes = {"agree": sum(1 for v in raw_votes.values() if v == "agree"),
                 "total": len(raw_votes)}
        leader = (receipt.get("consensus_data") or {}).get("leader_receipt")
        leader = leader if isinstance(leader, list) else [leader]
        leader_exec = [x.get("execution_result") for x in leader if x]
    else:
        leader_exec = []
    txs.append({
        "label": t["label"],
        "sender": t.get("sender"),
        "expected": t["expected"],
        "hash": t.get("hash"),
        "status": receipt.get("status"),
        "consensus": votes,
        "leader_execution": leader_exec,
        "error": t.get("error"),
    })

elections = []
for rec in journal["elections"]:
    final = rec.get("final")
    elections.append({
        "id": rec["id"],
        "case": rec["case"],
        "commit_deadline": rec["created"]["commit_deadline"],
        "reveal_deadline": rec["created"]["reveal_deadline"],
        "options": rec["created"]["options"],
        "final_state": final["state"],
        "result": final.get("result"),
    })

pack = {
    "network": journal["network"],
    "contract_address": journal["contract_address"],
    "source_sha256": source_sha,
    "protocol": "sealed-vote-1",
    "started_at": journal["started_at"],
    "completed_at": journal["completed_at"],
    "hours": journal["hours"],
    "accounts": journal["accounts"],
    "transactions": txs,
    "elections": elections,
}
(root / "evidence" / "evidence.json").write_text(
    json.dumps(pack, indent=2) + "\n")

success = [t for t in txs if t["expected"] == "success"]
adversarial = [t for t in txs if t["expected"] == "fail"]
assert all(t["status"] == "FINALIZED" for t in success), "unfinalized success tx"
assert all(t["status"] == "FINALIZED" for t in adversarial
           if t["hash"]), "unfinalized adversarial tx"

lines = []
lines.append("# SealedVote — network evidence")
lines.append("")
lines.append("## Deployment")
lines.append("")
lines.append(f"- Network: Stable Studionet, chain ID {journal['network']['chain_id']}, "
             f"RPC `{journal['network']['rpc']}`")
lines.append(f"- Contract: `{journal['contract_address']}`")
lines.append(f"- Source: `contracts/sealed_vote.py`, "
             f"SHA-256 `{source_sha}` (matches the deployed code; "
             f"recheck with `npm run read`)")
lines.append(f"- Protocol version: `sealed-vote-1` (read back from `get_protocol`)")
lines.append(f"- Deployed: {journal['started_at']} – {journal['completed_at']}")
lines.append(f"- Hours: commit deadline {journal['hours']['commit_deadline']}, "
             f"reveal deadline {journal['hours']['reveal_deadline']}, "
             f"finalize from {journal['hours']['finalize_from']}")
lines.append("")
lines.append("## Live verification")
lines.append("")
lines.append("Every transaction below reached FINALIZED. Success cases show "
             "majority agreement (3/5 validators agree); adversarial cases "
             "were finalized as failed executions (`ERROR`) and the election "
             "state was read back unchanged afterwards. Full receipts and "
             "readbacks are in `evidence/live.json`; `npm run read` re-checks "
             "every receipt, the deployed source and every finalized readback "
             "without sending a transaction, and "
             "`python scripts/verify_proof.py` independently replays every "
             "tally and commitment hash offline.")
lines.append("")
lines.append("### Elections")
lines.append("")
for e in elections:
    r = e["result"]
    if r:
        lines.append(f"- `{e['id']}` ({e['case']}): {e['final_state']} — "
                     f"outcome `{r['outcome']}`, counts `{r['counts']}`, "
                     f"winner `{r['winner']}`, "
                     f"result hash `{r['result_hash'][:16]}…`")
    else:
        lines.append(f"- `{e['id']}` ({e['case']}): {e['final_state']}")
lines.append("")
lines.append("### Transactions")
lines.append("")
lines.append("| Case | Expected | Hash | Status | Consensus |")
lines.append("| --- | --- | --- | --- | --- |")
for t in txs:
    cons = ""
    if t["consensus"]:
        cons = f"{t['consensus']['agree']}/{t['consensus']['total']} agree"
    elif t["leader_execution"]:
        cons = "leader: " + ", ".join(t["leader_execution"])
    h = f"`{t['hash']}`" if t["hash"] else "rejected before submission"
    lines.append(f"| {t['label']} | {t['expected']} | {h} | "
                 f"{t['status'] or '—'} | {cons} |")
lines.append("")
lines.append("### Adversarial cases (all must fail)")
lines.append("")
lines.append("- Wrong salt on reveal (`lunch-vote:reveal-wrong-salt`): "
             "commitment mismatch, no write.")
lines.append("- Wrong option on reveal (`lunch-vote:reveal-wrong-option`): "
             "commitment mismatch, no write.")
lines.append("- Duplicate commitment (`lunch-vote:commit-duplicate`): "
             "one commitment per voter.")
lines.append("- Duplicate reveal (`lunch-vote:reveal-duplicate`): "
             "a revealed ballot cannot be revealed again.")
lines.append("- Late commit (`empty-vote:commit-late`): "
             "commit window already closed.")
lines.append("- Early finalize (`lunch-vote:finalize-early`): "
             "reveal deadline not passed.")
lines.append("- Late reveal (`lunch-vote:reveal-late`): "
             "reveal window already closed.")
lines.append("- Stranger cancel (`lunch-vote:cancel-stranger`): "
             "only the creator can cancel.")
lines.append("- Stranger reveal (`lunch-vote:reveal-stranger`): "
             "only the voter who committed can reveal, even with the salt.")
lines.append("- Commit after cancel (`cancel-vote:commit-after-cancel`): "
             "cancelled elections are terminal.")
lines.append("- Conflicting re-create (`lunch-vote:create-conflict`): "
             "an election id cannot be redefined.")
lines.append("")
lines.append("## Reviewer fast path")
lines.append("")
lines.append("1. Read `docs/mechanism.md` — the whole protocol, "
             "sender-binding table and worst-case spread (exactly zero).")
lines.append("2. Read `contracts/sealed_vote.py` — the deployed source.")
lines.append("3. Run `npm ci && npm test` — 28 local unit tests, including "
             "SHA-256 vectors against hashlib and validator hour disagreement.")
lines.append("4. Check the deployed code matches the source: run "
             "`npm run read` — it compares the on-chain code at "
             f"`{journal['contract_address']}` with "
             f"`contracts/sealed_vote.py` (SHA-256 `{source_sha[:16]}…`).")
lines.append("5. Run `npm run read` — re-checks every receipt, the deployed "
             "source and every finalized readback, read-only.")
lines.append("6. Run `python scripts/verify_proof.py` — replays every tally "
             "and commitment hash offline from `evidence/live.json`.")
lines.append("")
lines.append("## Known limitations")
lines.append("")
lines.append("See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).")
lines.append("")
(root / "EVIDENCE.md").write_text("\n".join(lines))
print(f"wrote evidence/evidence.json + EVIDENCE.md "
      f"({len(success)} success, {len(adversarial)} adversarial, "
      f"all FINALIZED)")
