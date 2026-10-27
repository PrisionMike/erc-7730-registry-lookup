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
- the **whole descriptor file**, verbatim.

Every artifact is printed *and* copied to your clipboard. Fixtures are also
saved under `output/` (gitignored), alongside the function's definition as
the JSON the firmware tests read.

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
| Definitions source (used for the `--definitions` flag, the support check, the fixture's definition JSON, and token metadata in the standard parse) | Pick it from **Definitions source** on the home screen, or set `definitionsSource` (`tarball` · `dev` · `prod`) in `config.local.json`. See [Definitions source](#definitions-source) |
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

## Definitions source

The **Definitions source** entry on the home screen picks where definitions
come from. Whatever you pick is what `trezorctl --definitions` gets, and what
the support check, the fixture's definition JSON and the token metadata in the
standard parse read from:

| Source | `--definitions` value |
|---|---|
| **Tarball** (default) | your tarball path — offered pre-filled with the current one, edit it freely (leave empty to omit the flag) |
| **Dev definitions** | `https://dev.firmware.sldev.cz/unsigned/v2/definitions/` — the output of trezor/definitions' "[Deploy] unsigned dev firmware definitions" workflow |
| **Prod definitions** | `https://data.trezor.io/firmware/definitions/v2/` |

Both URLs are the v2 tree (`trzd2` blobs). trezorlib's own `-a` default is the
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
└── eth/chain-id/1/display-format/
    └── bbbbbbbbbb…ffcb-50d8cd4b.json      ← definition, as test JSON
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
- `src/jsonView.ts` — the display-format and descriptor JSON dumps
- `src/registryGit.ts` — submodule status and updates; `src/registryReport.ts`
  renders their results, shared with `src/registryCli.ts` (the `npm run
  registry:*` entrypoint)
- `src/definitionsSource.ts` — tarball-or-URL dispatch for lookup and reads, and the dev/prod URLs
- `src/tarball.ts` — Trezor definitions archive lookup and reads
- `src/definitionJson.ts` — `.dat` → firmware test JSON (a port of trezorlib's
  protobuf decoding); `src/datToJsonCli.ts` is its `npm run dat-to-json` entrypoint
- `src/localConfig.ts` — `config.local.json` and env overrides
- `src/ui.ts` — terminal styling, `src/output.ts` / `src/clipboard.ts` — delivery
