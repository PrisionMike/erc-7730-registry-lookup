# ERC-7730 Registry Lookup

Interactive CLI for Trezor clear-signing QA. Browse the [ERC-7730 clear-signing
registry](https://github.com/ethereum/clear-signing-erc7730-registry) with your
keyboard (provider → contract descriptor → function → chain), then generate
test artifacts from **real on-chain transactions** fetched via Etherscan:

- a ready-to-run `trezorctl ethereum sign-tx` command,
- an Etherscan link to a real transaction calling that function,
- a **standard parse** of that transaction's calldata — the clear-signing
  display the registry's own CI renders for it,
- a device test fixture JSON (drop-in for the Trezor firmware test suite),
- a **Trezor support check** — is this function's clear-signing definition
  actually in your definitions tarball?
- the **registry's own display format** for that function, with its `$.`
  references resolved, so you can see exactly how the registry wants the
  transaction rendered,
- the **whole descriptor file**, verbatim,
- a **cooked** transaction: start from a real one, edit the values its
  standard parse shows (amounts, addresses, dates, enums, `msg.value`, chain
  id, …), and get any of the above for the edited version — plus a registry
  test case.

Every artifact is printed *and* copied to your clipboard. Fixtures are also
saved under `output/` (gitignored), alongside the definitions the test needs
— the function's, the contract's name, and those of the tokens and contracts
in the calldata — as the JSON the firmware tests read.

## Prerequisites

- Node.js ≥ 22 (required by the clear-signing renderer)
- `tar` with xz support (any normal Linux/macOS) for the definitions tarball
  features.
- On Linux, clipboard support needs `xclip` (X11) or `wl-clipboard` (Wayland).
  The tool still works without them — you just copy the output manually.

## Setup

```bash
git clone --recurse-submodules <this-repo-url>
cd erc-7730-registry-lookup
npm install
```

If you already cloned without `--recurse-submodules`, or the `registry/`
directory is empty, fetch the registry submodule:

```bash
git submodule update --init
```

## Updating the registry

The registry is vendored as a git submodule pinned to a specific commit. The
pinned commit is shown in the startup banner, so you always know which registry
you are looking at.

To move it, pick **Registry (update / pin info)** on the home screen. You can
jump to the latest upstream commit, or check out a specific hash or tag to see
what a particular PR changed. Either way it reports how many commits you moved,
which descriptor files changed, and which providers appeared or disappeared.

The same thing without the TUI:

```bash
npm run registry:status              # what is currently pinned
npm run registry:update              # move to the latest upstream commit
npm run registry:update -- <ref>     # move to a specific commit hash or tag
```

Moving the submodule leaves the parent repo showing `registry` as modified. To
keep the new version:

```bash
git add registry && git commit -m "Bump registry"
```

Or to go back to the pinned commit:

```bash
git submodule update --checkout registry
```

Both flows refuse to touch `registry/` while it has uncommitted changes, and
always fetch before resolving a ref, so a hash pushed minutes ago still works.

## Usage

```bash
npm start
```

Navigate with the arrow keys, press Enter to select. Provider and descriptor
lists support type-to-filter — just start typing. Every menu has a `← Back`
entry; Ctrl+C exits anywhere.

The home screen offers **Browse the registry** and **Registry (update / pin
info)** (see [Updating the registry](#updating-the-registry)).

Browse flow: **provider** (e.g. `morpho`) → **descriptor** (a contract, e.g.
`MorphoBlue`) → **function** (e.g. `borrow — Borrow from Morpho Market`) →
**chain** (from the descriptor's deployments) → **action**.

The first action that needs a real transaction queries Etherscan for the most
recent successful one calling that function on the chosen deployment, paging
back through up to the last 10,000 transactions (Etherscan's search limit); it
is cached and reused for subsequent actions. The two JSON dumps read only the
registry, so they need no API key and work for functions with no recent
on-chain activity.

### Configuration

You need an [Etherscan API key](https://etherscan.io/apis) (free tier works
for Ethereum mainnet). Copy the example config and fill it in:

```bash
cp config.local.example.json config.local.json
```

```json
{
  "etherscanApiKey": "YOUR_KEY_HERE",
  "blockscoutApiKey": "",
  "testWallet": {
    "mnemonic": "alcohol woman abuse must during monitor noble actual mixed trade anger aisle",
    "passphrase": ""
  },
  "definitionsSource": "tarball",
  "definitionsPath": "~/Downloads/deploy.tar.xz"
}
```

`config.local.json` is gitignored — it never gets committed. The test wallet
(the publicly known SLIP-14 test mnemonic shown above) is used to sign
generated fixtures; leave it out and fixtures get empty `result` signatures.

| Setting | How |
|---|---|
| Etherscan API key | `ETHERSCAN_API_KEY` env var, or `etherscanApiKey` in `config.local.json` |
| Blockscout PRO API key (optional) | `BLOCKSCOUT_API_KEY` env var, or `blockscoutApiKey` in `config.local.json` |
| Fixture-signing test wallet | `testWallet` in `config.local.json` |
| Definitions source (used for the `--definitions` flag, the support check, the fixture's definition JSON, and token metadata in the standard parse) | Pick it from **Definitions source** on the home screen, or set `definitionsSource` (`tarball` · `dev` · `dev-signed` · `prod`) in `config.local.json`. See [Definitions source](#definitions-source) |
| Definitions tarball path (when the source is `tarball`) | `TREZOR_DEFINITIONS` env var, or `definitionsPath` in `config.local.json` — you're prompted once and the answer is saved there |

Note: a free-tier Etherscan key covers Ethereum mainnet and some other
chains; others (Optimism, Base, Gnosis, BNB) require a paid plan. Where a
keyless Blockscout instance exists (Optimism, Base, Gnosis, Celo, Arbitrum,
Polygon, Ethereum) the tool falls back to it automatically. Flare (14),
Songbird (19), Rootstock (30), B² (223), zkSync Era (324), Merlin (4200),
Bitlayer (200901) and Scroll aren't on Etherscan at all and go straight to
Blockscout; Avalanche goes straight to Routescan. BNB has no fallback.

Keyless Blockscout instances rate-limit hard (HTTP 429 after ~10 requests on
some). With a free [Blockscout PRO API key](https://dev.blockscout.com) the
tool uses `api.blockscout.com` instead for Ethereum, Optimism, Rootstock,
Gnosis, Polygon, zkSync Era, Base, Arbitrum, Celo and Scroll (5 requests/s).
Flare, Songbird, B², Merlin and Bitlayer run their own explorers and aren't
affected by the key.

## Generated artifacts

**trezorctl command** — real calldata, value, gas limit and gas price (in wei)
from the looked-up transaction; nonce is always 0:

```
trezorctl ethereum --definitions ~/Downloads/deploy.tar.xz sign-tx \
  --chain-id 1 --address "m/44h/60h/0h/0/0" \
  --data 50d8cd4b… --gas-limit 312644 --gas-price 1500000000 --nonce 0 \
  0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb 0
```

**Standard parse** — the transaction rendered by
[`@ethereum-sourcify/clear-signing`](https://www.npmjs.com/package/@ethereum-sourcify/clear-signing),
the reference ERC-7730 implementation the registry CI runs its Sourcify tests
with (pinned to the same version). The Python `erc7730` package CI also
installs only lints and converts descriptors — it never decodes calldata.

```
Intent:   Supply
Owner:    Aave DAO

Amount to supply      23924.06881 USDT
Collateral recipient  0xdce4EBC164EcE2845ad12525DEF06b8E0DDbCC0e
```

Descriptors are read from the pinned `registry/` checkout, not GitHub, so a
parse always matches the registry version in the banner. The function's own
descriptor is used for the selected deployment, and every other descriptor is
indexed too, so calldata-embedded inner calls (bundler/multicall legs, Safe
transactions) render recursively.

Token symbols/decimals and the native currency come from the definitions
tarball — the same signed metadata the device gets — so a token the device
would call unknown shows as a raw amount with `⚠ UNKNOWN_TOKEN`. With no
tarball configured, every amount renders raw. Addresses are never named (no
ENS or address book is wired in); `@.from` is the original transaction's
sender. The renderer's warnings (`⚠ CODE: …`) are printed inline, and the full
display model is saved to `output/…_parsed.json`.

**Device test fixture** — matches the firmware test suite shape:

```json
{
  "name": "morpho_MorphoBlue_borrow",
  "parameters": {
    "comment": "supported | https://etherscan.io/tx/0x…",
    "data": "50d8cd4b…",
    "path": "m/44'/60'/0'/0/0",
    "to_address": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    "chain_id": 1,
    "nonce": "0x0",
    "gas_price": "0x59682f00",
    "gas_limit": "0x4c544",
    "tx_type": null,
    "value": "0x0"
  },
  "result": { "sig_v": 37, "sig_r": "b7b423c0…", "sig_s": "2548c132…" }
}
```

The comment prefix is `supported` or `unsupported` based on the definitions
tarball (see below); when no tarball is configured it defaults to `supported`.

The `result` signatures are computed by signing the fixture's exact legacy
EIP-155 transaction (same nonce/gas/chain-id/data) with the configured
`testWallet` at the fixture's derivation path — so the fixture is a complete,
verifiable test case. Without a `testWallet` they're left empty.

**Registry display format** — what the registry says should appear on the
device for that function, with every `$.` reference resolved. The block itself
often lives in an included file (145 of the 247 descriptors define no formats
of their own), and the values it points at can come from the descriptor you
selected, so both are shown together:

```json
{
  "function": "deposit(uint256 assets, address receiver)",
  "selector": "0x6e553f65",
  "source": "ercs/calldata-erc4626-vaults.json",
  "format": {
    "intent": "Deposit",
    "fields": [
      { "path": "assets", "label": "Deposit asset", "format": "tokenAmount",
        "params": { "token": "$.metadata.constants.underlyingToken" } },
      { "label": "Share ticker", "format": "raw",
        "value": "$.metadata.constants.vaultTicker" }
    ]
  },
  "references": {
    "$.metadata.constants.underlyingToken": "0xA0b8…eB48",
    "$.metadata.constants.vaultTicker": "kAaveUSDC"
  }
}
```

**Whole descriptor file** — the selected file verbatim, so the registry's own
key order and formatting survive. Its include chain is printed above it.

Both are copied to the clipboard and saved under `output/`. Anything longer
than 120 lines is previewed rather than dumped, and offers to open in `$PAGER`
(default `less`).

## Cooking a transaction

**Cook a transaction** (on the action screen) lets you change what a real
transaction says before turning it into artifacts — an amount of 0, an
unlimited approval, an expired deadline, a token the device doesn't know, a
recipient that is the sender.

1. **Pick a starting transaction**: the latest one on-chain (the same
   Etherscan / Blockscout lookup the other actions use, and the default), or
   any case from the registry's own `tests/` and `testsv2/` files that calls
   this function.
2. **Edit.** The menu lists the transaction's own fields, then every field of
   the standard parse with its rendered value. A field whose format reads
   another value gets a `↳` row for it — a `tokenAmount`'s token (its
   `tokenPath`), a `calldata` field's callee, and so on. Pick a row to change
   it, and the parse re-renders straight away (warnings included), so you see
   what the device-facing display becomes. Edited rows are marked `✎ edited`;
   setting a value back to where it started clears the mark.
3. **Done** → choose a trezorctl command, the standard parse, a device test
   fixture, a registry test case, the raw transaction, or all of them. You can
   come back and keep editing.

Every edit offers presets plus **Manual…**, which starts from the current
value:

| Value | Presets |
|---|---|
| Address (`addressName`, `tokenTicker`, a token, spender, callee) | `0xDDdD…`, `0xEeee…` (the usual native-currency placeholder), `0x0000…`, `msg.from`, `msg.to`, the test wallet; for `msg.to`, the descriptor's other deployments |
| Amount (`amount`, `tokenAmount`, `msg.value`) | 0, 1, max; the descriptor's threshold (e.g. renders “All”/“Unlimited”); one whole native coin |
| `date` | now, in 1 hour / 1 day / 30 days / 1 year, 1 hour ago, 2³²−1 — shown as dates; manual is a raw integer |
| `duration` | 1 hour … 365 days |
| `enum` | the descriptor's enum values by name |
| `chainId`, chain id | the chains this tool knows |
| bool | true / false |
| bytes | empty or all-zero; manual hex (a fixed size, e.g. `bytes32` or a `.[0:20]` slice, must stay that size) |

**Any calldata argument** reaches arguments the parse hides
(`visible: never`, e.g. a permit's deadline), and **Raw calldata** edits the
hex directly. Descriptor constants (`$.metadata…`) show but can't be edited:
they aren't in the transaction.

How the edits map back: the function's signature (its registry format key)
decodes the calldata, and each display field's `path` — with field groups,
`.[]` iteration, `$ref` definitions and byte slices resolved exactly as the
renderer does — picks the argument it shows. Edits re-encode the call; bytes
after the arguments (some routers append a referral tag) are kept. Array
lengths can't change. Functions keyed by a bare selector have no signature,
so only the transaction fields and raw calldata are editable.

Notes on the outputs:

- `msg.from` only matters to the standard parse (`@.from`); trezorctl and
  fixtures sign as the device's own account. When the starting transaction
  names no sender, `msg.from` starts as the test wallet.
- The fixture is named `<provider>_<descriptor>_<function>_cooked` by default
  (you're asked, pre-filled), its comment says what it was cooked from and
  what changed, and it is saved with its definitions like any other fixture.
  Support is checked for the cooked chain id, `to` and selector.
- The **registry test case** is a whole `.tests.json`
  (`specs/erc7730-tests-v2.schema.json`) with one case: the unsigned legacy
  transaction as `rawTx`, `from` only when the descriptor reads `@.from`, the
  rendered display as `expected` (groups flattened, nested calls nested), and
  the tokens it rendered with as `dataProvider.tokens`, so the registry CI —
  which never touches the network — renders it the same way. It is saved as
  `output/<…>_<chainId>_cooked.tests.json`; merge its case into
  `registry/<provider>/testsv2/`, after checking `expected` is what the
  device should show.

## Definitions source

The **Definitions source** entry on the home screen picks where definitions
come from. Whatever you pick is what `trezorctl --definitions` gets, and what
the support check, the fixture's definition JSON and the token metadata in the
standard parse read from:

| Source | `--definitions` value |
|---|---|
| **Tarball** (default) | your tarball path — offered pre-filled with the current one, edit it freely (leave empty to omit the flag) |
| **Dev definitions** | `https://dev.firmware.sldev.cz/unsigned/v2/definitions/` — the output of trezor/definitions' "[Deploy] unsigned dev firmware definitions" workflow |
| **Dev signed definitions** | `https://dev.firmware.sldev.cz/signed/v2/definitions/` — the dev channel's signed definitions |
| **Prod definitions** | `https://data.trezor.io/firmware/definitions/v2/` |

All URLs are the v2 tree (`trzd2` blobs). trezorlib's own `-a` default is the
unversioned `data.trezor.io/firmware/definitions/` path, which still serves
legacy v1 blobs. The selection is saved as `definitionsSource` in
`config.local.json`.

With a URL source nothing is unpacked: a function is supported iff the URL
serves its `.dat`, and creating a fixture downloads that `.dat` and converts it
to JSON, just as it would from a tarball.

## Definitions tarball features

The Trezor definitions tarball stores one clear-signing definition per
function-contract-deployment:

```
<prefix>eth/chain-id/<chainId>/display-format/<address>-<selector>.dat
```

Either ball works — point `definitionsPath` at whichever you have:

| Ball | Entries look like |
|---|---|
| `deploy.tar.xz` | `definitions/eth/chain-id/…` |
| `definitions.tar.xz` (nested inside `deploy.tar.xz`) | `eth/chain-id/…` |

The prefix is detected per tarball from its own index, so you don't have to say
which kind you handed over.

A function is **supported iff that file exists in the tarball** — the
"Check Trezor support" action tells you exactly that (the tarball index is
loaded once per session and cached).

## Output folder

Generated fixtures are written to `output/` (gitignored):

```
output/
├── morpho_MorphoBlue_borrow_1.json        ← fixture (suffix = chain id)
├── morpho_MorphoBlue_borrow_1_parsed.json ← standard parse display model
├── morpho_MorphoBlue_borrow_format.json   ← registry display format
├── morpho_MorphoBlue_descriptor.json      ← descriptor file, verbatim
└── eth/chain-id/1/
    ├── display-format/
    │   ├── bbbbbbbbbb…ffcb-50d8cd4b.json          ← definition
    │   └── bbbbbbbbbb…ffcb-0000000000000000.json  ← contract name
    └── token-a0b86991…eb48.json                   ← a token from the calldata
```

When you create a fixture for a supported function, its definition is read
from the definitions source and saved as JSON under `output/eth/chain-id/…` —
the same layout as trezor-firmware's
`common/tests/fixtures/ethereum/definitions/`, so the tree can be copied there
as is. The device tests no longer take `.dat` files: they read these JSONs and
dev-sign them on the fly (trezor-firmware#8001). The JSON is the decoded
protobuf payload, byte-identical to what trezor-firmware's
`tools/snippets/eth_defs_dat_to_json.py` writes, except that the signature is
not verified (the tests re-sign anyway). It is rewritten on every fixture, so
it always reflects the current source.

Alongside it goes the called contract's **contract-name definition**,
`display-format/<address>-0000000000000000`, whenever the source has one (for
supported and unsupported functions alike). It is a display format with an
8-byte null selector, so it can't collide with a real function, and only its
`provider_name` matters: the device asks for it to name a contract whenever it
shows that contract's address. The dev definitions carry these; older tarballs
don't.

The same goes for **every address in the calldata** — a token, a vault, a
recipient, a router inside a multicall leg: its contract-name definition and
its `token-<address>` definition are saved too, whichever the source has, so
the test has what the device asks for when it shows that address or an amount
of that token. The called contract's token definition is looked up the same
way. Addresses are found by decoding the calldata with the function's
signature; `bytes` arguments (nested calls) are scanned word by word for
anything shaped like an address, as is the whole calldata when the signature
doesn't decode it. Addresses with nothing in the source are listed, not
treated as errors.

To convert a `.dat` you already have:

```bash
npm run dat-to-json -- <file.dat>            # writes <file>.json next to it
npm run dat-to-json -- <file.dat> -o -       # or -o <out.json>; - is stdout
```

## Development

```bash
npm run typecheck
```

Source layout:

- `src/main.ts` — navigation loop and screen stack
- `src/registry.ts` — descriptor loading; resolves the `includes` mechanism used
  by ~150 registry files, and the `$.` references inside a display format
- `src/selector.ts` — signature → 4-byte selector via ethers
- `src/etherscan.ts` — Etherscan V2 client (with Blockscout / Routescan fallback)
- `src/generate.ts` — trezorctl command and fixture builders
- `src/cook.ts` — the cook session: starting transaction, edit menu, outputs;
  `src/cookSlots.ts` maps display fields to the values they show,
  `src/calldataTree.ts` decodes, edits and re-encodes calldata by those paths,
  `src/cookPrompts.ts` holds the per-format value pickers,
  `src/registryTests.ts` finds registry test cases to start from, and
  `src/testCase.ts` writes a cooked transaction as one
- `src/jsonView.ts` — the display-format and descriptor JSON dumps
- `src/registryGit.ts` — submodule status and updates; `src/registryReport.ts`
  renders their results, shared with `src/registryCli.ts` (the `npm run
  registry:*` entrypoint)
- `src/definitionsSource.ts` — tarball-or-URL dispatch for lookup and reads, and the dev/prod URLs
- `src/tarball.ts` — Trezor definitions archive lookup and reads
- `src/fixtureDefinitions.ts` — which definitions a fixture needs, saved as test JSON;
  `src/calldataAddresses.ts` finds the addresses in its calldata
- `src/definitionJson.ts` — `.dat` → firmware test JSON (a port of trezorlib's
  protobuf decoding); `src/datToJsonCli.ts` is its `npm run dat-to-json` entrypoint
- `src/localConfig.ts` — `config.local.json` and env overrides
- `src/ui.ts` — terminal styling, `src/output.ts` / `src/clipboard.ts` — delivery
