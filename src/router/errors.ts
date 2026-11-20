// The job ended at the provider without a usable video. The ledger row becomes 'failed'.
export class JobEndedError extends Error {}
// The job exists but its video could not be fetched now. The ledger row stays 'submitted' and the slot is tried again.
export class ClipPendingError extends Error {}
// The paid call was never sent: nothing was spent. `refused` is a price or balance limit, which a retry would not change.
export class NotSentError extends Error {
  refused = false;
}
