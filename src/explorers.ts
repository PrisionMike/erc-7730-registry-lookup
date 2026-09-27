interface Explorer {
  name: string;
  host: string;
}

const EXPLORERS: Record<number, Explorer> = {
  1: { name: "Ethereum", host: "etherscan.io" },
  10: { name: "Optimism", host: "optimistic.etherscan.io" },
  14: { name: "Flare", host: "flare-explorer.flare.network" },
  19: { name: "Songbird", host: "songbird-explorer.flare.network" },
  30: { name: "Rootstock", host: "rootstock.blockscout.com" },
  56: { name: "BNB Chain", host: "bscscan.com" },
  100: { name: "Gnosis", host: "gnosisscan.io" },
  137: { name: "Polygon", host: "polygonscan.com" },
  223: { name: "B² Network", host: "explorer.bsquared.network" },
  324: { name: "zkSync Era", host: "explorer.zksync.io" },
  4200: { name: "Merlin", host: "scan.merlinchain.io" },
  8453: { name: "Base", host: "basescan.org" },
  42161: { name: "Arbitrum One", host: "arbiscan.io" },
  42220: { name: "Celo", host: "celoscan.io" },
  43114: { name: "Avalanche", host: "snowscan.xyz" },
  59144: { name: "Linea", host: "lineascan.build" },
  200901: { name: "Bitlayer", host: "www.btrscan.com" },
  534352: { name: "Scroll", host: "scrollscan.com" },
};

export function chainName(chainId: number): string {
  return EXPLORERS[chainId]?.name ?? `chainId ${chainId}`;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const explorer = EXPLORERS[chainId];
  return explorer ? `https://${explorer.host}/tx/${hash}` : `https://blockscan.com/tx/${hash}`;
}
