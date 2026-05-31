"use client";
import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

// 全域導航進度條：任何站內連結點擊立刻啟動，pathname 穩定後完成。
// 偵測方式：document 級別 click capture 抓所有 <a>；nav 那邊也是 Link 所以同一條路徑。
// 比起 router events（Next 14/15 沒公開 API）更穩，跨 Server/Client component 都能跑。
export function NavProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = React.useState(0);
  const [visible, setVisible] = React.useState(false);
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopAll = React.useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const start = React.useCallback(() => {
    stopAll();
    setVisible(true);
    setProgress(15);
    let p = 15;
    intervalRef.current = setInterval(() => {
      // 緩動曲線：剩餘距離 (90 - p) 取 8% → 越接近 90 越慢，模擬實際載入感
      const step = Math.max(0.5, (90 - p) * 0.08);
      p = Math.min(90, p + step);
      setProgress(p);
      if (p >= 90 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 60);
  }, [stopAll]);

  const finish = React.useCallback(() => {
    stopAll();
    setProgress(100);
    fadeTimerRef.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 200);
  }, [stopAll]);

  // 兩條偵測：
  //   1. document click capture：抓 <Link> / <a> 點擊瞬間，bar 立即顯示，使用者感受零延遲
  //   2. monkey-patch history.pushState / replaceState：抓 router.push / router.replace
  //      這些 button onClick 之類「不經過 <a>」的程式化導航。Next 內部最終都呼叫這兩個。
  // 兩條互補，任何形式的導航都不會漏。
  React.useEffect(() => {
    // ---- (1) link click ----
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      const a = target?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href) return;
      if (
        a.target === "_blank" ||
        a.hasAttribute("download") ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      )
        return;
      try {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      } catch {
        return;
      }
      start();
    };
    document.addEventListener("click", onClick, true);

    // ---- (2) history API patch ----
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    const isInternalNav = (urlArg: unknown): boolean => {
      if (urlArg == null) return false;
      try {
        const u =
          typeof urlArg === "string"
            ? new URL(urlArg, window.location.href)
            : urlArg instanceof URL
              ? urlArg
              : null;
        if (!u) return false;
        if (u.origin !== window.location.origin) return false;
        if (u.pathname === window.location.pathname && u.search === window.location.search) return false;
        return true;
      } catch {
        return false;
      }
    };
    history.pushState = function (data: any, unused: string, url?: string | URL | null) {
      if (isInternalNav(url)) start();
      return origPush.call(this, data, unused, url);
    };
    history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
      if (isInternalNav(url)) start();
      return origReplace.call(this, data, unused, url);
    };

    return () => {
      document.removeEventListener("click", onClick, true);
      history.pushState = origPush;
      history.replaceState = origReplace;
    };
  }, [start]);

  // pathname / search 變化即代表導航完成 → 收尾。
  const navKey = `${pathname}?${searchParams?.toString() || ""}`;
  const lastKeyRef = React.useRef(navKey);
  React.useEffect(() => {
    if (navKey !== lastKeyRef.current) {
      lastKeyRef.current = navKey;
      finish();
    }
  }, [navKey, finish]);

  // 頁面 unmount 時清計時器，避免 setState on unmounted
  React.useEffect(() => () => stopAll(), [stopAll]);

  return (
    <div
      aria-hidden
      className="fixed left-0 top-0 z-[60] h-[2px] bg-primary pointer-events-none overflow-hidden"
      style={{
        width: `${progress}%`,
        opacity: visible ? 1 : 0,
        transition: visible ? "width 200ms ease-out, opacity 100ms" : "opacity 200ms 100ms",
        boxShadow: visible ? `0 0 10px hsl(var(--primary)), 0 0 5px hsl(var(--primary))` : undefined,
      }}
    >
      {/* 沿 bar 跑的高光 shimmer：即使 bar 寬度暫時不變（到達 90% 後 hold），這道光持續移動，
          視覺上「還在 loading」訊號不間斷。寬 50% 的白色透明帶 1.2s 循環左→右。 */}
      {visible && (
        <span
          aria-hidden
          className="absolute inset-y-0 -left-1/2 w-1/2 nav-progress-shimmer"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%)",
          }}
        />
      )}
    </div>
  );
}
