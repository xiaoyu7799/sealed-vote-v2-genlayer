export function assertSuccessfulConsensus(r) {
  if (r?.status !== 'FINALIZED' || r.leader_only !== false
      || r.execution_mode !== 'NORMAL' || r.appealed !== false)
    throw Error('Not finalized normal non-appealed consensus');
  if (![6, '6', 'MAJORITY_AGREE'].includes(r.result))
    throw Error('Consensus did not agree: ' + r.result);
  const votes = Object.values(r.consensus_data?.votes ?? {});
  if (votes.length < 3
      || votes.filter((v) => v === 'agree').length <= votes.length / 2)
    throw Error('Missing majority evidence');
  const receipts = r.consensus_data?.leader_receipt;
  const list = Array.isArray(receipts) ? receipts : [receipts];
  if (!list.some((x) => x?.mode === 'leader'
      && x?.execution_result === 'SUCCESS'))
    throw Error('No successful leader execution');
  return { agree: votes.filter((v) => v === 'agree').length,
           total: votes.length, result: 'MAJORITY_AGREE' };
}
