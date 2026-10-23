// The version of the contract set (Bible section 4). Types with a `schema` literal carry their own version in the data.
// LedgerEntry, VoiceKit and ModelCatalogEntry have no literal, so a change to them bumps this set version and is recorded in the
// section 4 migration note. Bump it with every contract change, and only with the lead's approval.

export const CONTRACTS_VERSION = "engine-contracts@10" as const;
