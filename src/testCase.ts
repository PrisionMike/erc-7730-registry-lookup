import path from "node:path";
import type { DisplayModel } from "@ethereum-sourcify/clear-signing";
import { getAddress } from "ethers";
import { tokenDefinition, type TokenDefinition } from "./definitions.js";
import { flatFields, intentText } from "./parse.js";
import { REGISTRY_ROOT, type Descriptor } from "./registry.js";
import { TarballError } from "./tarball.js";

/**
 * A transaction as a registry test case (specs/erc7730-tests-v2.schema.json):
 * the rendered display becomes `expected`, and the token metadata it was
 * rendered with becomes `dataProvider.tokens`, so the registry CI — which
 * never touches the network — renders it the same way.
 */

interface Expected {
  intent: string;
  interpolatedIntent?: string;
  owner?: string;
  fields: { label: string; value: string | Expected }[];
}

function expected(model: DisplayModel): Expected {
  return {
    intent: intentText(model.intent) ?? "",
    ...(model.interpolatedIntent ? { interpolatedIntent: model.interpolatedIntent } : {}),
    ...(model.metadata?.owner ? { owner: model.metadata.owner } : {}),
    // Field groups flatten: the schema has only {label, value}, and a nested
    // object only for calldata-formatted fields.
    fields: flatFields(model).map((f) => ({
      label: f.label,
      value: f.embeddedCalldata ? expected(f.embeddedCalldata.display) : f.value,
    })),
  };
}

/** Tokens the display resolved, with the chain each was resolved on. */
function resolvedTokens(model: DisplayModel, chainId: number, into: Map<string, number>): void {
  for (const f of flatFields(model)) {
    if (f.tokenAddress && !f.warning) into.set(f.tokenAddress.toLowerCase(), chainId);
    if (f.embeddedCalldata) resolvedTokens(f.embeddedCalldata.display, f.embeddedCalldata.chainId ?? chainId, into);
  }
}

export interface TestCaseInput {
  description: string;
  rawTx: string;
  /** Only for descriptors that show @.from — the schema says to omit it otherwise. */
  from?: string;
  chainId: number;
}

/** A whole .tests.json for the descriptor, holding the one case. */
export async function registryTestFile(
  descriptor: Descriptor,
  model: DisplayModel,
  test: TestCaseInput,
  definitions: string | undefined,
): Promise<{ json: string; sourceErrors: Set<string> }> {
  const sourceErrors = new Set<string>();
  const wanted = new Map<string, number>();
  resolvedTokens(model, test.chainId, wanted);
  const tokens: Record<string, TokenDefinition> = {};
  if (definitions) {
    for (const [address, chainId] of wanted) {
      try {
        // Native-currency amounts carry a tokenAddress too, but have no token definition.
        const token = await tokenDefinition(definitions, chainId, address);
        if (token) tokens[address] = { symbol: token.symbol, decimals: token.decimals, name: token.name };
      } catch (err) {
        if (!(err instanceof TarballError)) throw err;
        sourceErrors.add(err.message);
      }
    }
  }
  const testsDir = path.join(REGISTRY_ROOT, descriptor.provider, "testsv2");
  const file = {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: path.relative(testsDir, descriptor.filePath),
    ...(Object.keys(tokens).length > 0 ? { dataProvider: { tokens } } : {}),
    tests: [
      {
        description: test.description,
        rawTx: test.rawTx,
        ...(test.from ? { from: getAddress(test.from) } : {}),
        expected: expected(model),
      },
    ],
  };
  return { json: JSON.stringify(file, null, 2), sourceErrors };
}
