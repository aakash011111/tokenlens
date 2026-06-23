export interface Pricing {
  inputPrice: number;      // $/MTok
  outputPrice: number;     // $/MTok
  cacheWritePrice: number; // $/MTok
  cacheReadPrice: number;  // $/MTok
}

const PRICING: Record<string, Pricing> = {
  'sonnet': {
    inputPrice: 3.00,
    outputPrice: 15.00,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.30,
  },
  'opus': {
    inputPrice: 15.00,
    outputPrice: 75.00,
    cacheWritePrice: 18.75,
    cacheReadPrice: 1.50,
  },
};

export function getPricing(model: string): Pricing {
  if (model.toLowerCase().includes('opus')) return PRICING['opus'];
  return PRICING['sonnet'];
}

export function tokToMTok(tokens: number): number {
  return tokens / 1_000_000;
}

export interface CacheHitCost {
  actualCost: number;
  normalCost: number;
  savedCost: number;
}

export function calcCacheHitCost(cacheReadTokens: number, model: string): CacheHitCost {
  const p = getPricing(model);
  const actualCost = tokToMTok(cacheReadTokens) * p.cacheReadPrice;
  const normalCost = tokToMTok(cacheReadTokens) * p.inputPrice;
  const savedCost = normalCost - actualCost;
  return { actualCost, normalCost, savedCost };
}

export function calcInputCost(tokens: number, model: string): number {
  return tokToMTok(tokens) * getPricing(model).inputPrice;
}

export function calcOutputCost(tokens: number, model: string): number {
  return tokToMTok(tokens) * getPricing(model).outputPrice;
}

export function calcCompactionSaving(tokens: number, model: string): number {
  // Tokens that would have accumulated as input in future turns
  return calcInputCost(tokens, model);
}

export function fmtUSD(amount: number): string {
  if (amount === 0) return '$0.000';
  if (amount < 0.0001) return '~$0.001';
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}
