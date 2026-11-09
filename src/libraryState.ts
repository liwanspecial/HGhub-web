import type { Detail, Episode } from './types';

export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };
export type VideoSnapshot = Detail & { cached_at: number };
export type VideoLibrary = Record<number, VideoSnapshot>;
export type ViewTab = 'home' | 'search' | 'category' | 'profile';
export type LibraryTab = 'history' | 'fav';
export type SavedView = { tab: ViewTab; libraryTab: LibraryTab; watch?: { id: number; ep: number } };
export const VIEW_KEY = 'hghub_view_v1';

const positive = (value: unknown, limit = Number.MAX_SAFE_INTEGER): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= limit ? number : undefined;
};
const bounded = (value: unknown, max = 86400): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : 0;
};
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';

/** @brief 兼容旧观看记录并约束进度字段。@param raw 本机已有数据。@return 保持原顺序的有效记录。 */
export function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw.flatMap((item, index) => {
    const record = typeof item === 'number' ? { id: item } : item;
    const id = positive(record?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, ep: positive(record.ep, 10000) ?? 1, t: bounded(record.t), dur: bounded(record.dur),
      at: positive(record.at) ?? Date.now() - index }];
  }).slice(0, 80);
}

/** @brief 只缓存展示用公开字段，不保存播放地址、鉴权、跟踪或账号交互数据。
 * @param raw 上游详情。@param at 缓存时间。@return 展示快照或无效数据标记。
 */
export function snapshotVideo(raw: unknown, at = Date.now()): VideoSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Detail>;
  const id = positive(value.id);
  if (!id || !text(value.title, 300).trim()) return null;
  const author = value.author;
  const episodes: Episode[] = Array.isArray(value.episodes) ? value.episodes.slice(0, 500).flatMap((item) => {
    const ep = positive(item?.ep_num, 10000);
    return ep ? [{ ep_num: ep, title: text(item.title, 200), duration: bounded(item.duration), status: bounded(item.status, 100) }] : [];
  }) : [];
  return {
    id, title: text(value.title, 300), cover: text(value.cover, 4096), description: text(value.description, 6000),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string').slice(0, 30).map((tag) => tag.slice(0, 80)) : [],
    score: bounded(value.score, 10), episode_count: positive(value.episode_count, 10000) ?? episodes.length,
    total_episodes: positive(value.total_episodes, 10000) ?? episodes.length, episodes,
    counts: { collect: bounded(value.counts?.collect, 1e12), comment: bounded(value.counts?.comment, 1e12),
      hot: bounded(value.counts?.hot, 1e12), like: bounded(value.counts?.like, 1e12) },
    author: { id: positive(author?.id) ?? 0, name: text(author?.name, 120) || '作者资料待加载',
      avatar: text(author?.avatar, 4096), followers: bounded(author?.followers, 1e12) },
    is_finished: !!value.is_finished, is_original: bounded(value.is_original, 1), cached_at: bounded(at, Number.MAX_SAFE_INTEGER),
  };
}

/** @brief 更新有界展示缓存，相同资料不触发反复写入。@param current 缓存。
 * @param raw 新资料。@param at 时间。@return 更新后的缓存。
 */
export function rememberVideo(current: VideoLibrary, raw: unknown, at = Date.now()): VideoLibrary {
  const snapshot = snapshotVideo(raw, at);
  if (!snapshot) return current;
  const previous = current[snapshot.id];
  if (previous && JSON.stringify({ ...previous, cached_at: 0 }) === JSON.stringify({ ...snapshot, cached_at: 0 })) return current;
  const entries = [snapshot, ...Object.values(current).filter((item) => item.id !== snapshot.id)]
    .sort((a, b) => b.cached_at - a.cached_at).slice(0, 120);
  return Object.fromEntries(entries.map((item) => [item.id, item]));
}

/** @brief 校验当前标签页的恢复位置。@param raw 保存的 JSON。@return 有效视图描述。 */
export function readView(raw: string | null): SavedView {
  const result: SavedView = { tab: 'home', libraryTab: 'history' };
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (['home', 'search', 'category', 'profile'].includes(value.tab)) result.tab = value.tab;
    if (value.libraryTab === 'fav') result.libraryTab = 'fav';
    const id = positive(value.watch?.id); const ep = positive(value.watch?.ep, 10000);
    if (id && ep) result.watch = { id, ep };
  } catch { /* 不改变已有观看历史。 */ }
  return result;
}

/** @brief 为暂时无法补全的记录提供可见占位。@param id 剧集编号。@return 展示模型。 */
export function pendingVideo(id: number): Detail {
  return { id, title: `剧集${id}`, cover: '', description: '', tags: [], score: 0, episode_count: 0,
    total_episodes: 0, episodes: [], counts: { collect: 0, comment: 0, hot: 0, like: 0 },
    author: { id: 0, name: '作者资料待加载' }, is_finished: false, is_original: 0 };
}
