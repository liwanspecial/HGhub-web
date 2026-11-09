import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { Detail, User } from "./types";
import { isNative } from "./runtime";
import { normalizeHistory, snapshotVideo, rememberVideo as mergeVideo, readView, VIEW_KEY,
  type LibraryTab, type VideoLibrary, type WatchProgress } from "./libraryState";
export type { WatchProgress } from "./libraryState";

export type Platform = "android" | "ios" | "windows" | "macos";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

type Persist = {
  library: VideoLibrary;
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  library: {},
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [],
};

/** @brief 读取并兼容已有本机记录。@return 校验过的偏好、历史与展示缓存。 */
function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    const library: VideoLibrary = {};
    if (p.library && typeof p.library === "object") {
      Object.values(p.library).slice(0, 120).forEach((entry) => {
        const snapshot = snapshotVideo(entry, entry?.cached_at ?? 0);
        if (snapshot) library[snapshot.id] = snapshot;
      });
    }
    const ids = (value: unknown): number[] => Array.isArray(value) ? value.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
    return { library, likes: ids(p.likes), favs: ids(p.favs), follows: ids(p.follows),
      muteOnStartup, muted: muteOnStartup || p.muted === true,
      volume: Number.isFinite(p.volume) ? Math.max(0, Math.min(1, p.volume)) : .7,
      searchHist: Array.isArray(p.searchHist) ? p.searchHist.filter((s) => typeof s === "string").slice(0, 12) : [],
      history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

/** @brief 同步保存用户操作，缓存超限时优先保留观看记录。@param value 本机状态。@return 保存是否成功。 */
function writePersist(value: Persist): boolean {
  try { localStorage.setItem(LS, JSON.stringify(value)); return true; }
  catch {
    try { localStorage.setItem(LS, JSON.stringify({ ...value, library: {} })); return true; }
    catch { return false; }
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  library: VideoLibrary; rememberVideo: (detail: Detail) => void;
  libraryTab: LibraryTab; setLibraryTab: (tab: LibraryTab) => void;
  rememberPlayback: (id: number, ep: number, scope: string) => void;
  storageError: boolean;
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

/** @brief 管理本机记录和网页刷新恢复位置。@param children 应用内容。@return 状态提供器。 */
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setPersistState] = useState<Persist>(loadPersist);
  const persistRef = useRef(p);
  const [storageError, setStorageError] = useState(false);
  const setP = useCallback((update: React.SetStateAction<Persist>) => {
    const next = typeof update === "function" ? update(persistRef.current) : update;
    if (next === persistRef.current) return;
    persistRef.current = next;
    setStorageError(!writePersist(next));
    setPersistState(next);
  }, []);
  const [restored] = useState(() => {
    try { return readView(isNative ? null : sessionStorage.getItem(VIEW_KEY)); }
    catch { return readView(null); }
  });
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>(restored.tab);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>(restored.libraryTab);
  const [stack, setStack] = useState<Page[]>(() => {
    if (!restored.watch) return [];
    const { id, ep } = restored.watch;
    const progress = p.history.find((entry) => entry.id === id && entry.ep === ep);
    return [{ kind: "feed", key: "restored-watch", videoIds: [id], index: 0, title: p.library[id]?.title || "继续观看",
      source: "restore", startEp: ep, startTime: progress?.t }];
  });
  const [lastWatch, setLastWatch] = useState<{ id: number; ep: number; scope: string } | null>(
    restored.watch ? { ...restored.watch, scope: "restored-watch" } : null,
  );
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    if (isNative) return;
    const page = stack[stack.length - 1];
    const scope = page?.kind === "feed" ? page.key : !page && tab === "home" ? "home" : null;
    const watch = scope && lastWatch?.scope === scope ? { id: lastWatch.id, ep: lastWatch.ep }
      : page?.kind === "feed" ? { id: page.videoIds[page.index], ep: page.startEp || 1 } : undefined;
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ tab, libraryTab, watch })); } catch { /* 本地记录单独保留。 */ }
  }, [tab, stack, libraryTab, lastWatch]);

  /** @brief 保存用于刷新恢复的剧集位置。@param id 剧集。@param ep 集数。@param scope 页面标识。@return 无。 */
  const rememberPlayback = useCallback((id: number, ep: number, scope: string) => {
    setLastWatch((previous) => previous?.id === id && previous.ep === ep && previous.scope === scope ? previous : { id, ep, scope });
  }, []);
  /** @brief 缓存展示资料的白名单字段。@param detail 剧集详情。@return 无。 */
  const cacheVideo = useCallback((detail: Detail) => {
    setP((state) => { const library = mergeVideo(state.library, detail); return library === state.library ? state : { ...state, library }; });
  }, [setP]);

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (r.user && (r.user as User).id) setUser(r.user as User);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); }, []);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [],
    library: Object.fromEntries(Object.entries(s.library).filter(([id]) => s.favs.includes(Number(id)))) })), [setP]);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    library: p.library, rememberVideo: cacheVideo, libraryTab, setLibraryTab, rememberPlayback, storageError,
    platform: envPlatform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast,
  }), [theme, tab, setTab, stack, push, pop, user, loginOpen, logout, cacheVideo, libraryTab, rememberPlayback, storageError,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    setMuted, setMuteOnStartup, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, theater, setTheater, fs, setFs]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
