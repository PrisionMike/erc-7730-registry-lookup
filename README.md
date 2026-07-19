# ERC-7730 Registry Lookup

Interactive CLI for Trezor clear-signing QA. Browse the [ERC-7730 clear-signing
registry](https://github.com/ethereum/clear-signing-erc7730-registry) with your
keyboard (provider → contract descriptor → function → chain), then generate
test artifacts from **real on-chain transactions** fetched via Etherscan:

- a ready-to-run `trezorctl ethereum sign-tx` command,
- an Etherscan link to a real transaction calling that function,
- a device test fixture JSON (drop-in for the Trezor firmware test suite).

Every artifact is printed *and* copied to your clipboard.

## Prerequisites

- Node.js ≥ 20
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

The registry is vendored as a git submodule pinned to a specific commit. To
pull the latest descriptors from upstream:

```bash
git submodule update --remote registry
git add registry && git commit -m "Bump registry"   # optional: pin the new version
```

## Usage

```bash
npm start
```

Navigate with the arrow keys, press Enter to select. Provider and descriptor
lists support type-to-filter — just start typing. Every menu has a `← Back`
entry; Ctrl+C exits anywhere.

Flow: **provider** (e.g. `morpho`) → **descriptor** (a contract, e.g.
`MorphoBlue`) → **function** (e.g. `borrow — Borrow from Morpho Market`) →
**chain** (from the descriptor's deployments) → **action**.

The first action for a selection queries Etherscan for the most recent
successful transaction (within the last 200) calling that function on the
chosen deployment; it is cached and reused for subsequent actions.

### Configuration

You need an [Etherscan API key](https://etherscan.io/apis) (free tier works
for Ethereum mainnet). Copy the example config and fill it in:

```bash
cp config.local.example.json config.local.json
```

```json
{
  "etherscanApiKey": "YOUR_KEY_HERE"
}
```

`config.local.json` is gitignored — it never gets committed.

| Setting | How |
|---|---|
| Etherscan API key | `ETHERSCAN_API_KEY` env var, or `etherscanApiKey` in `config.local.json` |
| Trezor definitions tarball (`--definitions` flag in generated commands) | `TREZOR_DEFINITIONS` env var, or you're prompted once and the path is saved to `~/.config/erc7730-lookup/config.json` |

Note: the built-in free-tier Etherscan key covers Ethereum mainnet; some other
chains (e.g. Base) require a paid plan and will report "Free API access is not
supported for this chain".

## Generated artifacts

**trezorctl command** — real calldata, fixed gas/nonce:

```
trezorctl ethereum --definitions ~/Downloads/deploy.tar.xz sign-tx \
  --chain-id 1 --address "m/44h/60h/0h/0/0" \
  --data 50d8cd4b… --gas-limit 333333 --gas-price 22 --nonce 0 \
  0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb 0
```

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
    "gas_price": "0x14",
    "gas_limit": "0x14",
    "tx_type": null,
    "value": "0x0"
  },
  "result": { "sig_v": 0, "sig_r": "", "sig_s": "" }
}
```

## Development

```bash
npm run typecheck
```

Source layout: `src/registry.ts` (descriptor loading, resolves the `includes`
mechanism used by ~150 registry files), `src/selector.ts` (signature → 4-byte
selector via ethers), `src/etherscan.ts` (Etherscan V2 client),
`src/generate.ts` (command/fixture builders), `src/main.ts` (navigation loop).
