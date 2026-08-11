export type Matcher =
  | { type: 'exact'; value: string | string[] }
  | { type: 'prefix'; value: string | string[] }
  | { type: 'suffix'; value: string | string[] }
  | { type: 'contains'; value: string | string[] }
  | { type: 'regex'; value: string }
  | { type: 'is-set' };

export type Condition =
  | { type: 'and'; conditions: Condition[] }
  | { type: 'or'; conditions: Condition[] }
  | { type: 'not'; condition: Condition }
  | { type: 'matcher'; matcher: Matcher };

export type UrlRuleMatcher = {
  path?: Condition;
  queryParam?: {
    key: Condition;
    value: Condition;
  };
};

export type UrlTransformRule = {
  // Update the path of the URL to the given value.
  updatedPath?: string;

  // Add the given query key & value to the URL. If the query key already
  // exists, it will be updated.
  updateMatchedQueryParams?:
    | { type: 'set'; key: Condition; value: string }
    | { type: 'remove'; key: Condition };

  // If set, then remove all other query params that are not touched by the
  // updated query params.
  removeNotUpdatedQueryParams?: boolean;
};

export type UrlNormalizeRule = {
  rules?: {
    matcher: UrlRuleMatcher;
    transform: UrlTransformRule;
  }[];
};
