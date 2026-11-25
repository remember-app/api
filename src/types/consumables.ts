export type SpendConsumable = {
  spend: number;
};

export type TokensConsumable = {
  tokens: number;
};

export type StorageConsumable = {
  bytes: number;
};

export type Consumable = {
  tokens: TokensConsumable & SpendConsumable;
  storage: StorageConsumable & SpendConsumable;
};
