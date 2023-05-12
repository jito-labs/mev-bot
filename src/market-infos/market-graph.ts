import { PublicKey } from '@solana/web3.js';
import { toPairString } from './common.js';
import { Market } from './types.js';

type PairString = string;

class Node {
  id: string;
  neighbours: Set<string>;

  constructor(pubKey: string) {
    this.id = pubKey;
    this.neighbours = new Set<string>();
  }
}

class MintMarketGraph {
  nodes: Map<string, Node>;
  edges: Map<PairString, Array<Market>>;

  constructor() {
    this.nodes = new Map<string, Node>();
    this.edges = new Map<string, Array<Market>>();
  }

  addMint(pubKey: PublicKey): void {
    const pubKeyStr = pubKey.toBase58();
    if (!this.nodes.has(pubKeyStr)) {
      this.nodes.set(pubKeyStr, new Node(pubKeyStr));
    }
  }

  addMarket(mint1: PublicKey, mint2: PublicKey, market: Market): void {
    this.addMint(mint1);
    this.addMint(mint2);

    const node1 = this.nodes.get(mint1.toBase58());
    const node2 = this.nodes.get(mint2.toBase58());

    node1.neighbours.add(mint2.toBase58());
    node2.neighbours.add(mint1.toBase58());

    const edgeKey = toPairString(mint1, mint2);
    if (!this.edges.has(edgeKey)) {
      this.edges.set(edgeKey, []);
    }

    this.edges.get(edgeKey).push(market);
  }

  getNeighbours(pubKey: PublicKey): Set<string> {
    const node = this.nodes.get(pubKey.toBase58());
    return node ? node.neighbours : new Set();
  }

  getMarkets(mint1: PublicKey, mint2: PublicKey): Array<Market> {
    const edgeKey = toPairString(mint1, mint2);
    return this.edges.get(edgeKey) || [];
  }
}

export { MintMarketGraph };
