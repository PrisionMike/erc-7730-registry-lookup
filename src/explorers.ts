interface Explorer {
  name: string;
  host: string;
}

const EXPLORERS: Record<number, Explorer> = {
  1: { name: "Ethereum", host: "etherscan.io" },
  10: { name: "Optimism", host: "optimistic.etherscan.io" },
  56: { name: "BNB Chain", host: "bscscan.com" },
  100: { name: "Gnosis", host: "gnosisscan.io" },
  137: { name: "Polygon", host: "polygonscan.com" },
  8453: { name: "Base", host: "basescan.org" },
  42161: { name: "Arbitrum One", host: "arbiscan.io" },
  42220: { name: "Celo", host: "celoscan.io" },
  43114: { name: "Avalanche", host: "snowscan.xyz" },
  59144: { name: "Linea", host: "lineascan.build" },
  534352: { name: "Scroll", host: "scrollscan.com" },
};

export function chainName(chainId: number): string {
  return EXPLORERS[chainId]?.name ?? `chainId ${chainId}`;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const explorer = EXPLORERS[chainId];
  return explorer ? `https://${explorer.host}/tx/${hash}` : `https://blockscan.com/tx/${hash}`;
}
