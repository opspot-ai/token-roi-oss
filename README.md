# Token ROI local meter

Token ROI is an experimental local CLI and browser dashboard for recording AI work costs and customer-assigned value. The source includes CSV and JSON import, reports for a UTC time window and currency, and JSON or CSV ledger export. It does not connect to providers or verify imported amounts or coverage; assigned value is not revenue.

## Requirements

Node.js 24.21.x or 26.7.x, as declared in `package.json`. The project uses Node.js built-in modules and has no package dependencies to install. Give every command an explicit local ledger path.

## Example

```sh
mkdir -p ./data
node bin/token-roi.mjs import --ledger ./data/ledger.json --input ./examples/demo.json
node bin/token-roi.mjs report --ledger ./data/ledger.json \
  --from 2026-10-10T00:00:00Z --to 2026-10-13T00:00:00Z --currency USD
node bin/token-roi.mjs export --ledger ./data/ledger.json --output ./data/export.json
node bin/token-roi.mjs serve --ledger ./data/ledger.json
```

Open the local `127.0.0.1` address printed by `serve`. Imports can use `.csv` or `.json` files; format can also be set with `--format csv|json`. The dashboard accepts either format. CLI help is available with `node bin/token-roi.mjs --help`; the checked-in test command is `npm test`.

## Limitations

This is experimental as-is source. Bugs and incomplete features may remain. The latest source edit is untested, and behavior was not verified in this sanitation batch; tests were not run. Reports depend on user-supplied records, assumptions, and coverage labels and are not provider-reconciled financial results.
