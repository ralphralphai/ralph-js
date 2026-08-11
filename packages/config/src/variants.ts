import type { UrlRuleMatcher } from '@/url_normalize';

export type Variant = {
  id: string;
  queryParams?: {
    key: string;
    value: string;
  }[];
};

export type VariantRule = {
  rules?: {
    matcher: UrlRuleMatcher;
    variants: Variant[];
  }[];
};
