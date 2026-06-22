"use client";

import * as React from "react";

// Lightweight, dependency-free i18n. Two locales: Traditional Chinese (default,
// matching the reference UI) and English. Locale is persisted in localStorage.
//
// To avoid SSR/client hydration mismatch, the first render on both server and
// client uses the default locale ("zh-Hant"); the stored preference is applied
// in an effect after mount.

export type Locale = "zh-Hant" | "en";
export const LOCALE_KEY = "wolf_locale";
export const DEFAULT_LOCALE: Locale = "zh-Hant";

type Dict = Record<string, string>;

const zhHant: Dict = {
  // header / nav
  latency: "延遲監控",
  settings: "設定",
  logout: "登出",
  login: "登入",
  language: "切換語言 (中／EN)",

  // common
  overview: "概览",
  currentTime: "目前時間",
  updatedEvery: "每 {n}s 更新",

  // overview header / traffic
  publicBadge: "訪客視圖 · 已隱藏 IP",
  publicTitle: "訪客視圖 · 已隱藏 IP 等敏感信息",
  totalUp: "總上傳",
  totalDown: "總下載",
  upRate: "上行速率",
  downRate: "下行速率",

  // summary
  totalServers: "總計伺服器",
  onlineServers: "線上伺服器",
  offlineServers: "離線伺服器",

  // filters
  viewGrid: "網格",
  viewList: "列表",
  regAll: "全部",
  regCN: "大陸",
  regOversea: "海外",
  sort: "排序",
  sortDefault: "預設",
  sortName: "名稱",
  sortCpu: "CPU",
  sortMem: "內存",
  sortCountry: "地區",
  sortStatus: "狀態",

  // empty states
  noNodes: "尚無節點上報。",
  startNodeHint: "啟動一個指向此 master 的節點：",
  noNodesInCategory: "此分類下沒有伺服器。",

  // metric cell labels
  mCpu: "CPU",
  mMem: "內存",
  mStorage: "存儲",
  mUp: "上傳",
  mDown: "下載",
  mNet: "上下行",
  offline: "離線",

  // detail header fields
  status: "狀態",
  online: "在線",
  uptimeLabel: "運行時間",
  arch: "架構",
  memory: "內存",
  disk: "磁盤",
  region: "地區",
  system: "系統",
  cpu: "CPU",
  cores: "核",
  load: "Load",
  bootTime: "啟動時間",
  lastReport: "最後上報時間",

  // detail tabs / charts
  tabDetail: "詳細資訊",
  tabNetwork: "網路",
  chProcesses: "進程數",
  chDisk: "磁盤",
  chMemSwap: "內存 / Swap",
  chUpDown: "上傳 / 下載",
  chBandwidth: "網路頻寬用量",
  chTcp: "TCP 連線",
  ownLatency: "本機延遲",
  noHistory: "此時間範圍暫無歷史數據",
  collecting: "，正在採集…",
  notFoundServer: "找不到此伺服器。",
  backOverview: "返回概览",

  // ── admin: settings ──────────────────────────────────────────────
  loading: "載入中…",
  setTitle: "設定",
  setSub: "通知與監測",
  secServers: "伺服器",
  secServersDesc: "節點安裝 token、地理查詢，與拖曳排序。",
  publicDash: "公開儀表板",
  publicDashDesc:
    "訪客無需登入即可查看伺服器即時狀態（server live）。敏感資訊（如 IP）會自動隱藏。",
  ghProxy: "GitHub 加速",
  ghProxyDesc:
    "啟用後，安裝腳本與 wolf-node 二進位皆透過鏡像下載（適合大陸伺服器）。留空則使用 https://ghfast.top。",
  nodeTokenLabel: "節點 Token（用於安裝參數 -t）",
  newServerLabel: "新增節點安裝 Token",
  newServerDesc:
    "為一台尚未安裝的伺服器產生一個未綁定 Token；首次上報時將自動綁定該主機名。每台伺服器使用自己的 Token。",
  createToken: "建立 Token",
  nodeTokenHint: "此節點專屬 Token。重置後需重新安裝該節點。",
  msgTokenCreated: "Token 已建立。",
  deleteNode: "刪除節點",
  confirmDeleteNode: "確定刪除節點「{name}」？歷史數據、Token 與相關通知/監測設定將一併移除。",
  msgNodeDeleted: "已刪除節點「{name}」及其所有關聯設定。",
  dbUrl: "資料庫連線",
  dbUrlDesc: "目前 worker 連線使用的 DATABASE_URL；含密鑰，預設模糊顯示，移上去顯示內容，點擊一鍵複製。",
  clickToCopy: "點擊以複製",
  msgCopied: "已複製。",
  rotate: "重置",
  installLinux: "一鍵安裝 · Linux/macOS（HTTP 傳輸 — 通用，後端為任意反向代理皆可）：",
  installWin: "Windows（系統管理員 PowerShell）：",
  installWs: "若自架並使用 WebSocket：移除 -T http（並指向 ws(s):// 端點）。",
  ipinfoLabel: "ipinfo.io token（選填 — 提高地理查詢額度）",
  ipinfoPh: "ipinfo token",
  save: "儲存",
  customOrder: "自訂排序 · 拖曳調整",
  noServersYet: "尚無伺服器",
  msgPublicOn: "已開啟公開儀表板。",
  msgPublicOff: "已關閉公開儀表板。",
  msgPublicFail: "更新公開存取失敗。",
  msgSaved: "已儲存。",
  msgFailed: "失敗。",
  msgTokenRotated: "Token 已重置 — 請更新你的節點。",
  msgOrderSaved: "排序已儲存。",
  msgOrderFail: "排序儲存失敗。",
  secNotify: "通知",
  notifyTplDesc: "模板佔位符：",
  enableNotify: "開啟通知",
  msgTemplate: "訊息通知模板",
  apiEndpoint: "請求端點 · API endpoint *",
  sendTest: "發送測試訊息",
  msgSendingTest: "傳送測試中…",
  msgTestSent: "測試已發送",
  msgTestFail: "測試失敗：",
  secAlerts: "負載通知",
  secAlertsDesc: "當指標在時間窗內維持 ≥ 門檻達到指定比例時觸發。",
  thName: "名稱",
  thMetric: "指標",
  thThreshold: "門檻",
  thRatio: "比例",
  thWindow: "窗口",
  thServers: "伺服器",
  thOn: "啟用",
  all: "全部",
  noRules: "尚無規則",
  add: "新增",
  known: "已知：",
  phName: "名稱",
  phServersBlank: "伺服器（留空 = 全部）",
  secOffline: "離線通知",
  secOfflineDesc: "當伺服器超過寬限時間未上報時通知。",
  thServer: "伺服器",
  thEnabled: "啟用",
  thGrace: "寬限（秒）",
  thStatus: "狀態",
  stOffline: "離線",
  stOnline: "在線",
  secPing: "延遲監測",
  secPingDesc: "選定的伺服器會依設定間隔探測目標。",
  thTarget: "目標",
  thType: "類型",
  thInterval: "間隔",
  noMonitors: "尚無監測",
  phTarget: "目標（ip / host[:port]）",
  selAll: "全部伺服器",
  selCount: "已選 {n} 台",
  selExclude: "黑名單 {n} 台",
  modeInclude: "指定",
  modeExclude: "黑名單",
  groupBy: "分組",
  grpRegion: "地區",
  grpStatus: "狀態",
  grpNone: "不分組",
  grpUnknown: "未知",
  grpOnline: "在線",
  grpOffline: "離線",
  grpCN: "大陸",
  grpOversea: "海外",
  clearSel: "清除選擇",
  cancel: "取消",
  edit: "編輯",
  viewInstall: "安裝腳本",
  nodeName: "顯示名稱",
  secOpaque: "伺服器連結 ID（進階）",
  opaqueWarn:
    "此金鑰用於產生伺服器頁面網址中的不透明 ID。除非你清楚其用途，否則不建議更動——變更後既有的伺服器連結會全部失效。",
  opaqueKey: "加密金鑰 (hex)",
  opaqueTweak: "Tweak (hex)",
  regenerate: "重新隨機產生",

  // ── admin: latency view ──────────────────────────────────────────
  latTitle: "延遲",
  latSub: "延遲監測",
  monitors: "監測",
  noMonitorsYet: "尚無延遲監測。",
  addUnder: "在此新增：",
  settingsLatency: "設定 → 延遲監測",
  waitingSamples: "等待樣本中…",
  timeout: "逾時",
};

const en: Dict = {
  latency: "Latency",
  settings: "Settings",
  logout: "Sign out",
  login: "Sign in",
  language: "Switch language (中／EN)",

  overview: "Overview",
  currentTime: "Current time",
  updatedEvery: "Updated every {n}s",

  publicBadge: "Public · IP hidden",
  publicTitle: "Guest view · sensitive info such as IP is hidden",
  totalUp: "Total up",
  totalDown: "Total down",
  upRate: "Up rate",
  downRate: "Down rate",

  totalServers: "Total",
  onlineServers: "Online",
  offlineServers: "Offline",

  viewGrid: "Grid",
  viewList: "List",
  regAll: "All",
  regCN: "Mainland",
  regOversea: "Oversea",
  sort: "Sort",
  sortDefault: "Default",
  sortName: "Name",
  sortCpu: "CPU",
  sortMem: "Memory",
  sortCountry: "Region",
  sortStatus: "Status",

  noNodes: "No nodes reporting yet.",
  startNodeHint: "Start a node pointing at this master:",
  noNodesInCategory: "No servers in this category.",

  mCpu: "CPU",
  mMem: "MEM",
  mStorage: "DISK",
  mUp: "UP",
  mDown: "DOWN",
  mNet: "NET",
  offline: "Offline",

  status: "Status",
  online: "Online",
  uptimeLabel: "Uptime",
  arch: "Arch",
  memory: "Memory",
  disk: "Disk",
  region: "Region",
  system: "System",
  cpu: "CPU",
  cores: "cores",
  load: "Load",
  bootTime: "Boot time",
  lastReport: "Last report",

  tabDetail: "Details",
  tabNetwork: "Network",
  chProcesses: "Processes",
  chDisk: "Disk",
  chMemSwap: "Memory / Swap",
  chUpDown: "Up / Down",
  chBandwidth: "Network Bandwidth Usage",
  chTcp: "TCP conns",
  ownLatency: "This server's latency",
  noHistory: "No history for this time range",
  collecting: " — collecting…",
  notFoundServer: "Server not found.",
  backOverview: "Back to overview",

  // ── admin: settings ──────────────────────────────────────────────
  loading: "Loading…",
  setTitle: "Settings",
  setSub: "Notifications & monitoring",
  secServers: "Servers",
  secServersDesc: "Node install token, geo lookup, and drag-to-reorder.",
  publicDash: "Public dashboard",
  publicDashDesc:
    "Guests can view live server status without signing in. Sensitive info such as IP is hidden automatically.",
  ghProxy: "GitHub mirror",
  ghProxyDesc:
    "When on, the install script and wolf-node binary both download through a GitHub mirror (useful from mainland China). Leave the URL blank to use https://ghfast.top.",
  nodeTokenLabel: "Node token (use in install -t)",
  newServerLabel: "New server install token",
  newServerDesc:
    "Create an unbound token for a server you haven't installed yet — it binds to that server's hostname on its first report. Every node has its own token.",
  createToken: "Create token",
  nodeTokenHint: "This node's unique token. Rotating it requires reinstalling that node.",
  msgTokenCreated: "Token created.",
  deleteNode: "Delete node",
  confirmDeleteNode: "Delete node \"{name}\"? History, token, and all related alert / offline / latency settings will be removed.",
  msgNodeDeleted: "Node \"{name}\" and all its references were deleted.",
  dbUrl: "Database URL",
  dbUrlDesc: "DATABASE_URL the worker is connected to right now. Contains credentials, blurred by default — hover to reveal, click to copy.",
  clickToCopy: "Click to copy",
  msgCopied: "Copied.",
  rotate: "Rotate",
  installLinux: "One-click install · Linux/macOS (HTTP transport — works behind any reverse proxy):",
  installWin: "Windows (elevated PowerShell):",
  installWs: "Self-hosting with WebSocket? Drop -T http (and point at the ws(s):// endpoint).",
  ipinfoLabel: "ipinfo.io token (optional — higher geo lookup limits)",
  ipinfoPh: "ipinfo token",
  save: "Save",
  customOrder: "Custom order · drag to reorder",
  noServersYet: "no servers yet",
  msgPublicOn: "Public dashboard enabled.",
  msgPublicOff: "Public dashboard disabled.",
  msgPublicFail: "Failed to update public access.",
  msgSaved: "Saved.",
  msgFailed: "Failed.",
  msgTokenRotated: "Token rotated — update your nodes.",
  msgOrderSaved: "Order saved.",
  msgOrderFail: "Failed to save order.",
  secNotify: "Notifications",
  notifyTplDesc: "Template placeholders:",
  enableNotify: "Enable notifications",
  msgTemplate: "Message template",
  apiEndpoint: "API endpoint *",
  sendTest: "Send test",
  msgSendingTest: "Sending test…",
  msgTestSent: "Test sent",
  msgTestFail: "Test failed: ",
  secAlerts: "Load alerts",
  secAlertsDesc: "Fire when a metric stays ≥ threshold for at least the time-ratio over the window.",
  thName: "Name",
  thMetric: "Metric",
  thThreshold: "Threshold",
  thRatio: "Ratio",
  thWindow: "Window",
  thServers: "Servers",
  thOn: "On",
  all: "all",
  noRules: "no rules",
  add: "Add",
  known: "known: ",
  phName: "name",
  phServersBlank: "servers (blank = all)",
  secOffline: "Offline alerts",
  secOfflineDesc: "Notify when a server stops reporting beyond its grace period.",
  thServer: "Server",
  thEnabled: "Enabled",
  thGrace: "Grace (s)",
  thStatus: "Status",
  stOffline: "offline",
  stOnline: "online",
  secPing: "Latency monitors",
  secPingDesc: "Selected servers probe the target on the given interval.",
  thTarget: "Target",
  thType: "Type",
  thInterval: "Interval",
  noMonitors: "no monitors",
  phTarget: "target (ip / host[:port])",
  selAll: "All servers",
  selCount: "{n} selected",
  selExclude: "Blacklist {n}",
  modeInclude: "Include",
  modeExclude: "Blacklist",
  groupBy: "Group",
  grpRegion: "Region",
  grpStatus: "Status",
  grpNone: "None",
  grpUnknown: "Unknown",
  grpOnline: "Online",
  grpOffline: "Offline",
  grpCN: "Mainland",
  grpOversea: "Oversea",
  clearSel: "Clear selection",
  cancel: "Cancel",
  edit: "Edit",
  viewInstall: "Install script",
  nodeName: "Display name",
  secOpaque: "Server link ID (advanced)",
  opaqueWarn:
    "This key generates the opaque ID used in server page URLs. We don't recommend changing it unless you know what it's for — doing so invalidates all existing server links.",
  opaqueKey: "Encryption key (hex)",
  opaqueTweak: "Tweak (hex)",
  regenerate: "Regenerate randomly",

  // ── admin: latency view ──────────────────────────────────────────
  latTitle: "Latency",
  latSub: "Latency monitoring",
  monitors: "monitors",
  noMonitorsYet: "No latency monitors yet.",
  addUnder: "Add one under",
  settingsLatency: "Settings → Latency monitors",
  waitingSamples: "waiting for samples…",
  timeout: "timeout",
};

const messages: Record<Locale, Dict> = { "zh-Hant": zhHant, en };

type T = (key: keyof typeof zhHant | string, vars?: Record<string, string | number>) => string;

const I18nContext = React.createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggle: () => void;
  t: T;
}>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  toggle: () => {},
  t: (k) => String(k),
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(DEFAULT_LOCALE);

  React.useEffect(() => {
    const stored = localStorage.getItem(LOCALE_KEY) as Locale | null;
    if (stored === "en" || stored === "zh-Hant") {
      setLocaleState(stored);
      document.documentElement.lang = stored === "en" ? "en" : "zh-Hant";
    }
  }, []);

  const setLocale = React.useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LOCALE_KEY, l);
    } catch {}
    document.documentElement.lang = l === "en" ? "en" : "zh-Hant";
  }, []);

  const toggle = React.useCallback(
    () => setLocale(locale === "en" ? "zh-Hant" : "en"),
    [locale, setLocale],
  );

  const t = React.useCallback<T>(
    (key, vars) => {
      const dict = messages[locale];
      let s = dict[key as string] ?? messages[DEFAULT_LOCALE][key as string] ?? String(key);
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(`{${k}}`, String(v));
        }
      }
      return s;
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, toggle, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return React.useContext(I18nContext);
}
