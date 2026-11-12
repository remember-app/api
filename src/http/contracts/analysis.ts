export type AnalyzeItemsRequest = {
  itemIds: string[];
};

export type AnalyzeItemsResponse = {
  queued: number;
  tokens: number;
};
