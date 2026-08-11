# @ralphralphai/schema

The wire contract plus the columnar batch encoder. It is inlined into
`@ralphralphai/tracker` at build time.

After updating the ingestor schema, update the openapi.json to the generated
one.

## The type assertions are checking Rust against itself

`Columns` is not written down. It is derived from the `RalphEvent` union: `keyof` for the
columns every variant carries, `Exclude` for the rest. Rust emits its per-`ty` event
structs and its `Columns` struct independently, so `_ColumnsMatchesSpec` in `src/events.ts`
compares two separate statements it made: a column declared on a variant but missing from
`Columns`, or the reverse, is a type error on that line.

`_MandatoryColumnsListed` and `_SparseColumnsListed` in `src/encode.ts` then hold the
encoder's hand-written column lists to those same derived sets.
