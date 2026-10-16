import type { BlogArticle } from './types';

export type ArticleGrouping = 'archive' | 'category';
export interface ArticleGroup {
  key: string;
  label: string;
  articles: BlogArticle[];
  children: ArticleGroup[];
}

// Hexo treats a flat array as one hierarchy; nested arrays enable multiple
// independent hierarchies, with scalar entries then becoming root categories.
export function categoryPaths(value: unknown): string[][] {
  const name = (item: unknown): string => ['string', 'number', 'boolean'].includes(typeof item) ? String(item).trim() : '';
  const items = (Array.isArray(value) ? value : [value]).filter(item => Array.isArray(item) || name(item));
  const paths = items.some(Array.isArray) ? items.map(item => Array.isArray(item) ? item.map(name).filter(Boolean) : [name(item)]) : [items.map(name)];
  const unique = new Map(paths.filter(parts => parts.length).map(parts => [JSON.stringify(parts), parts]));
  return [...unique.values()];
}

function archiveMonth(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt\s]|$)/.exec(date);
  if (!match) return;
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return;
  return `${year}-${month}`;
}

export function groupArticles(articles: BlogArticle[], mode: ArticleGrouping): ArticleGroup[] {
  const roots: ArticleGroup[] = [];
  const nodes = new Map<string, ArticleGroup>();
  const addPath = (parts: string[], article: BlogArticle) => {
    let siblings = roots;
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1), key = `${mode}:${JSON.stringify(prefix)}`;
      let group = nodes.get(key);
      if (!group) {
        group = { key, label: parts[index]!, articles: [], children: [] };
        nodes.set(key, group); siblings.push(group);
      }
      if (index === parts.length - 1 && !group.articles.some(row => row.key === article.key)) group.articles.push(article);
      siblings = group.children;
    }
  };
  for (const article of articles) {
    if (mode === 'archive') {
      const month = archiveMonth(article.date);
      addPath(month ? [`${month.slice(0, 4)} 年`, `${month.slice(5)} 月`] : ['日期未知'], article);
    } else {
      if (article.categoryPaths.length) for (const parts of article.categoryPaths) addPath(parts, article);
    }
  }
  const sort = (groups: ArticleGroup[]) => {
    groups.sort((a, b) => mode === 'archive' ? b.label.localeCompare(a.label, 'en') : a.label.localeCompare(b.label, 'zh-CN'));
    for (const group of groups) sort(group.children);
  };
  sort(roots);
  if (mode === 'archive') {
    const unknown = roots.findIndex(group => group.label === '日期未知');
    if (unknown >= 0) roots.push(...roots.splice(unknown, 1));
  } else {
    const uncategorized = articles.filter(article => !article.categoryPaths.length);
    if (uncategorized.length) roots.push({ key: 'category:uncategorized', label: '未分类', articles: uncategorized, children: [] });
  }
  return roots;
}

export function articlesInGroup(group: ArticleGroup): BlogArticle[] {
  return [...new Map([...group.articles, ...group.children.flatMap(articlesInGroup)].map(article => [article.key, article])).values()];
}
