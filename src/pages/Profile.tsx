import { useEffect, useState } from "react";
import { api, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img } from "../components/ui";
import { IChevR, IClock, ILogout, ISettings, IStar, IUser } from "../icons";
import { pendingVideo } from "../libraryState";
import { isNative } from "../runtime";

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史）。
   收藏与观看记录都存在本地，所以未登录也照常展示；未登录时资料卡本身就是登录入口。 */
/** @brief 保留历史占位并按需补全公开资料。@param props 布局和页面可见性。@return 个人资料与本机记录页。 */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearHistory, push, library, rememberVideo,
    libraryTab: tab, setLibraryTab: setTab, storageError } = useStore();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(12);

  const ids = tab === "fav" ? favs : history.map((h) => h.id);
  const cards: Detail[] = ids.slice(0, limit).map((id) => library[id] || pendingVideo(id));
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const wanted = ids.slice(0, limit).filter((id) => retry > 0 || !library[id] || Date.now() - library[id].cached_at > 300000);
    if (!wanted.length) { setLoading(false); setFailed(false); return; }
    setLoading(true);
    let cursor = 0; let failures = 0;
    const load = async () => {
      while (alive && cursor < wanted.length) {
        const id = wanted[cursor++];
        try {
          const detail = await api.video(id);
          if (!detail?.id || !detail.title) throw new Error("资料暂不可用");
          if (alive) rememberVideo(detail);
        } catch { failures++; }
      }
    };
    void Promise.all([load(), load()]).finally(() => { if (alive) { setLoading(false); setFailed(failures > 0); } });
    return () => { alive = false; };
    // 资料写入缓存不重新启动这批请求。
  }, [active, ids.join(","), retry, limit, rememberVideo]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
        {isMobile && (
          <button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ml-auto w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <ISettings size={17} strokeWidth={1.7} />
          </button>
        )}
      </div>

      <div className="flex-1 scroll-y px-4 pt-2 pb-24">
        {/* 资料卡：已登录 / 未登录（点开登录抽屉） */}
        {user ? (
          <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
            <Avatar size={56} name={user.nickname} hue={280} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
              <div className="text-[11px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
                <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
                <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
              </div>
            </div>
            <button onClick={async () => { await logout(); }}
              className="w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable" aria-label="退出登录">
              <ILogout size={17} />
            </button>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full text-left rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[11px] text-mut mt-0.5">登录后可同步点赞、收藏与评论</div>
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>收藏 <b className="text-on">{favs.length}</b></span>
                <span>观看 <b className="text-on">{history.length}</b></span>
              </div>
            </div>
            <span className="flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold">
              登录<IChevR size={13} />
            </span>
          </button>
        )}

        {/* 我的内容 */}
        <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["fav", "我的收藏"], ["history", "观看历史"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
          ))}
        </div>

        <div className="mt-3" aria-label={tab === "history" ? "观看历史列表" : "收藏列表"}>
          {storageError && <p role="alert" className="text-[11px] text-danger mb-3">浏览器未能保存最新记录，请检查可用存储空间。</p>}
          {loading && <p role="status" className="text-[11px] text-mut mb-3">正在补全剧集资料，已有记录会保留…</p>}
          {failed && <div role="status" className="flex items-center gap-2 text-[11px] text-mut mb-3">
            <span>部分资料暂不可用，记录已保留</span>
            <button onClick={() => setRetry((value) => value + 1)} className="text-primary pressable" aria-label="重试加载资料">重试</button>
          </div>}
          {cards.length ? (
            <div className="grid grid-cols-3 gap-2">
              {cards.map((c) => {
                const p = progressOf(c.id);
                return (
                <button key={c.id} aria-label={`${tab === "history" ? "继续观看" : "观看"} ${c.title} 第 ${p?.ep || 1} 集`} onClick={() => push({
                  kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id),
                  title: tab === "fav" ? "我的收藏" : "观看历史",
                  startEp: p?.ep, startTime: p?.t,
                })}
                  className="relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable" style={{ paddingTop: "133%" }}>
                  <Img src={c.cover} />
                  {!!p && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                      第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                    {!library[c.id] && <div className="text-[9px] text-white/65 mt-1">资料待加载 · 记录保留</div>}
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {ids.length > cards.length && <button onClick={() => setLimit((value) => value + 12)} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">查看更多记录</button>}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看历史</button>
          )}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {!isNative ? "记录保存在此浏览器" : platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : "Windows"}</div>
      </div>
    </div>
  );
}
