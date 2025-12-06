import React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * GrantTagList - Display tags and categories
 * @param {Object} props
 * @param {string[]} props.tags - Grant tags
 * @param {string[]} props.categories - Grant categories
 */
const normalizeList = (arr) => {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const s = (typeof item === 'string' ? item : String(item ?? '')).trim();
    if (s) out.push(s);
  }
  // remove consecutive duplicates (keeps order; minimal change)
  const dedup = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup;
};

export default function GrantTagList({ tags, categories }) {
  const normTags = normalizeList(tags);
  const normCats = normalizeList(categories);

  const hasTags = normTags.length > 0;
  const hasCategories = normCats.length > 0;

  if (!hasTags && !hasCategories) return null;

  const topTags = normTags.slice(0, 2);
  const extraTags = Math.max(0, normTags.length - 2);

  const topCats = normCats.slice(0, 2);
  const extraCats = Math.max(0, normCats.length - 2);

  return (
    <div className="flex flex-wrap gap-1">
      {/* Tags */}
      {hasTags &&
        topTags.map((tag, i) => (
          <Badge
            key={`tag-${i}-${tag.slice(0, 24)}`}
            variant="secondary"
            className="text-xs px-1.5 py-0 hover:bg-slate-200 transition-colors"
            title={tag}
          >
            {tag}
          </Badge>
        ))}
      {hasTags && extraTags > 0 && (
        <Badge variant="secondary" className="text-xs px-1.5 py-0">
          +{extraTags}
        </Badge>
      )}

      {/* Categories */}
      {hasCategories &&
        topCats.map((cat, i) => (
          <Badge
            key={`cat-${i}-${cat.slice(0, 24)}`}
            variant="outline"
            className="text-xs px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 transition-colors"
            title={cat}
          >
            {cat}
          </Badge>
        ))}
      {hasCategories && extraCats > 0 && (
        <Badge variant="outline" className="text-xs px-1.5 py-0">
          +{extraCats}
        </Badge>
      )}
    </div>
  );
}