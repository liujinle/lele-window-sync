import { useState, useEffect, useCallback, useRef } from "react";
const QR_CODE = "/qrcode.png";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Monitor, Cpu, MousePointer2, Keyboard, Play, Square,
  RefreshCw, ChevronDown, ChevronRight, Search,
  CheckCircle2, Circle, Zap, Settings, Info, X,
  Minus as MinusIcon, Maximize2, BookmarkPlus, List, Trash2, Download, FolderOpen, Play as PlayIcon, Bell, Sun, Moon
} from "lucide-react";

interface WindowInfo  { hwnd: number; title: string; pid: number; visible: boolean }
interface ProcessInfo { pid: number; name: string; windows: WindowInfo[] }
interface AppShortcut {
  id: string;
  name: string;
  path: string;
  args?: string;
  icon?: string;
}

interface SyncStatus  { active: boolean; master_hwnd: number; slave_count: number; sync_mouse: boolean; sync_keyboard: boolean }
interface SyncPlan { id: string; name: string; masterHwnd: number; masterTitle: string; slaveMap: [number, string][]; syncMouse: boolean; syncKeyboard: boolean; createdAt: string }

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }

function getProcessIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("chrome") || n.includes("edge") || n.includes("firefox") || n.includes("browser")) return "🌐";
  if (n.includes("code") || n.includes("studio") || n.includes("idea")) return "💻";
  if (n.includes("note") || n.includes("word") || n.includes("写字板")) return "📝";
  if (n.includes("excel") || n.includes("wps")) return "📊";
  if (n.includes("game") || n.includes("steam") || n.includes("游戏")) return "🎮";
  if (n.includes("qq") || n.includes("wechat") || n.includes("微信")) return "💬";
  return "🪟";
}

// TitleBar — 拖动 + 窗口控制 + 主题切换 + 提醒
interface TitleBarProps { theme: 'dark'|'light'; onToggleTheme: () => void; }
function TitleBar({ theme, onToggleTheme }: TitleBarProps) {
  const handleMin = (e: React.MouseEvent) => { e.stopPropagation(); getCurrentWindow().minimize(); };
  const handleMax = (e: React.MouseEvent) => { e.stopPropagation(); getCurrentWindow().toggleMaximize(); };
  const [showAlert, setShowAlert]       = useState(false);
  const [showCloseMenu, setShowCloseMenu] = useState(false);
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <div className="titlebar-logo" data-tauri-drag-region><Zap size={13} /></div>
        <span className="titlebar-title" data-tauri-drag-region>乐享同步操作</span>
      </div>
      <div className="titlebar-controls" onMouseDown={e => e.stopPropagation()}>
        {/* 提醒按钮 */}
        <div className="tb-alert-wrap" onMouseEnter={() => setShowAlert(true)} onMouseLeave={() => setShowAlert(false)}>
          <button className="tb-btn tb-alert" title="使用提醒">
            <Bell size={12} /><span className="tb-alert-dot" />
          </button>
          {showAlert && (
            <div className="tb-alert-popup">
              <div className="tap-header">⚠️ 使用提醒</div>
              <div className="tap-title">需要管理员权限</div>
              <div className="tap-desc">同步官方游戏客户端时，Windows UIPI 会拦截消息，需以管理员身份运行本软件。</div>
              <div className="tap-how">
                <b>方法一：</b>右键 .exe → 以管理员身份运行<br/>
                <b>方法二：</b>右键属性 → 兼容性 → 勾选「以管理员身份运行此程序」
              </div>
            </div>
          )}
        </div>
        {/* 主题切换 */}
        <button className="tb-btn tb-theme" onClick={e=>{e.stopPropagation();onToggleTheme();}}
          title={theme==='dark'?'切换浅色模式':'切换深色模式'}>
          {theme==='dark' ? <Sun size={12}/> : <Moon size={12}/>}
        </button>
        <button className="tb-btn tb-min"   onClick={handleMin}><MinusIcon size={11} /></button>
        <button className="tb-btn tb-max"   onClick={handleMax}><Maximize2 size={10} /></button>
        <div style={{position:"relative"}}>
          <button className="tb-btn tb-close" onClick={e=>{e.stopPropagation();setShowCloseMenu(v=>!v);}}>
            <X size={11} />
          </button>
          {showCloseMenu && (
            <div className="close-menu" onMouseLeave={()=>setShowCloseMenu(false)}>
              <button className="close-menu-item" onClick={()=>{setShowCloseMenu(false);getCurrentWindow().hide();}}>
                <span className="cmi-icon">📥</span>
                <div><div className="cmi-title">最小化到托盘</div><div className="cmi-sub">程序后台继续运行</div></div>
              </button>
              <div className="close-menu-divider"/>
              <button className="close-menu-item close-menu-item-danger" onClick={()=>{setShowCloseMenu(false);getCurrentWindow().close();}}>
                <span className="cmi-icon">🚪</span>
                <div><div className="cmi-title">退出程序</div><div className="cmi-sub">停止同步并完全退出</div></div>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Process Panel ──────────────────────────────────────────────────────────────
interface ProcPanelProps {
  processes: ProcessInfo[];
  mode: "single" | "multi";
  selectedHwnd?: number | null;
  selectedHwnds?: Set<number>;
  onSelectSingle?: (hwnd: number, title: string) => void;
  onToggleSlave?: (hwnd: number, title: string) => void;
  onKillProcess?: (pid: number, name: string) => void;
  disabledHwnds?: number[];
  label: string;
  accentColor: string;
}

function ProcPanel({
  processes, mode, selectedHwnd, selectedHwnds, onSelectSingle, onToggleSlave,
  onKillProcess, disabledHwnds = [], label, accentColor
}: ProcPanelProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const filtered = processes.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.windows.some(w => w.title.toLowerCase().includes(search.toLowerCase()))
  );

  const toggle = (pid: number) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(pid) ? n.delete(pid) : n.add(pid);
    return n;
  });

  const selCount = mode === "multi" ? (selectedHwnds?.size ?? 0) : (selectedHwnd ? 1 : 0);

  return (
    <div className="proc-panel">
      <div className="proc-panel-header">
        <div className="proc-badge" style={{ background: accentColor }}>
          {label === "主窗口" ? <Monitor size={11} /> : <Cpu size={11} />}
        </div>
        <span className="proc-label">{label}</span>
        {selCount > 0 && (
          <span className="proc-sel-badge" style={{ borderColor: accentColor, color: accentColor }}>
            {mode === "multi" ? `已选 ${selCount}` : "已选择"}
          </span>
        )}
      </div>
      <div className="proc-search">
        <Search size={12} />
        <input placeholder="搜索进程或窗口…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="proc-list">
        {filtered.length === 0 && (
          <div className="proc-empty"><Monitor size={22} /><span>没有找到匹配项</span></div>
        )}
        {filtered.map(proc => {
          const open = expanded.has(proc.pid);
          return (
            <div key={proc.pid} className="proc-item">
              <div className="proc-item-hd" onClick={() => toggle(proc.pid)}>
                <span className="proc-arr">{open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</span>
                <span className="proc-ico">{getProcessIcon(proc.name)}</span>
                <span className="proc-name" title={`${proc.name} (PID:${proc.pid})`}>{proc.name}</span>
                <span className="proc-pid">#{proc.pid}</span>
                <span className="proc-cnt">{proc.windows.length}</span>
                {onKillProcess && (
                  <button className="proc-kill-btn"
                    onClick={e => { e.stopPropagation(); onKillProcess(proc.pid, proc.name); }}
                    title={`关闭 ${proc.name}`}>
                    <X size={10}/>
                  </button>
                )}
              </div>
              {open && (
                <div className="proc-wins">
                  {proc.windows.map(win => {
                    const disabled = disabledHwnds.includes(win.hwnd);
                    // 判断是否被选中
                    const selected = mode === "single"
                      ? selectedHwnd === win.hwnd
                      : (selectedHwnds?.has(win.hwnd) ?? false);

                    return (
                      <button
                        key={win.hwnd}
                        className={`proc-win${selected ? " selected" : ""}${disabled ? " disabled" : ""}`}
                        style={selected ? { "--accent": accentColor } as React.CSSProperties : {}}
                        disabled={disabled}
                        title={win.title}
                        onClick={() => {
                          if (disabled) return;
                          if (mode === "single") onSelectSingle?.(win.hwnd, win.title);
                          else onToggleSlave?.(win.hwnd, win.title);
                        }}
                      >
                        <span className="pw-icon">
                          {selected
                            ? <CheckCircle2 size={12} style={{ color: accentColor }} />
                            : <Circle size={12} />}
                        </span>
                        <span className="pw-title">{truncate(win.title, 36)}</span>
                        <span className="pw-hwnd">#{win.hwnd.toString(16).toUpperCase()}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [processes, setProcesses]     = useState<ProcessInfo[]>([]);
  const [masterHwnd, setMasterHwnd]   = useState<number | null>(null);
  const [masterTitle, setMasterTitle] = useState("");
  // 从窗口用 Map 存 hwnd → title，Set 用于快速判断选中
  const [slaveMap, setSlaveMap]       = useState<Map<number, string>>(new Map());
  const [syncMouse, setSyncMouse]     = useState(true);
  const [syncKeyboard, setSyncKeyboard] = useState(true);
  const [syncActive, setSyncActive]   = useState(false);
  const [plans, setPlans]             = useState<SyncPlan[]>(() => {
    try { return JSON.parse(localStorage.getItem('sync-plans') || '[]'); } catch { return []; }
  });
  const [showPlans, setShowPlans]     = useState(false);
  const [appShortcuts, setAppShortcuts] = useState<AppShortcut[]>(() => {
    try { return JSON.parse(localStorage.getItem('app-shortcuts') || '[]'); } catch { return []; }
  });
  const [showAddApp, setShowAddApp]   = useState(false);
  const [newAppName, setNewAppName]   = useState('');
  const [newAppPath, setNewAppPath]   = useState('');
  const [newAppArgs, setNewAppArgs]   = useState('');
  const [theme, setTheme]             = useState<'dark'|'light'>(() =>
    (localStorage.getItem('theme') as 'dark'|'light') || 'dark'
  );
  const [themeAnim, setThemeAnim]     = useState(false);
  const [loading, setLoading]         = useState(false);
  const [refreshing, setRefreshing]   = useState(false);
  const [log, setLog]                 = useState<{ time: string; msg: string; type: "info"|"success"|"error" }[]>([]);
  const [activeTab, setActiveTab]     = useState<"setup"|"status"|"apps">("setup");
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((msg: string, type: "info"|"success"|"error" = "info") => {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLog(prev => [...prev.slice(-49), { time, msg, type }]);
  }, []);

  const handleKillProcess = useCallback(async (pid: number, name: string) => {
    try {
      await invoke('kill_process', { pid });
      addLog('已关闭进程: ' + name + ' (PID:' + pid + ')', 'success');
      // 刷新进程列表
      const procs = await invoke<ProcessInfo[]>('get_processes');
      setProcesses(procs);
    } catch (e) {
      addLog('关闭失败: ' + name + ' — ' + e, 'error');
    }
  }, [addLog]);

  const loadProcesses = useCallback(async () => {
    setRefreshing(true);
    try {
      const procs = await invoke<ProcessInfo[]>("get_processes");
      setProcesses(procs);
      addLog(`已加载 ${procs.length} 个进程`, "info");
    } catch (e) { addLog(`加载失败: ${e}`, "error"); }
    finally { setRefreshing(false); }
  }, [addLog]);

  useEffect(() => { loadProcesses(); }, [loadProcesses]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  useEffect(() => {
    const u = listen<SyncStatus>("sync-status-changed", e => {
      setSyncActive(e.payload.active);
      addLog(e.payload.active ? "同步已启动" : "同步已停止", e.payload.active ? "success" : "info");
    });
    return () => { u.then(f => f()); };
  }, [addLog]);

  const slaveSet = new Set(slaveMap.keys());

  const handleMasterSelect = (hwnd: number, title: string) => {
    setMasterHwnd(hwnd);
    setMasterTitle(title);
    // 若该窗口已在从窗口列表里，移除
    if (slaveMap.has(hwnd)) {
      setSlaveMap(prev => { const n = new Map(prev); n.delete(hwnd); return n; });
    }
    addLog(`主窗口: ${truncate(title, 40)}`, "info");
  };

  const handleToggleSlave = (hwnd: number, title: string) => {
    if (hwnd === masterHwnd) return;
    setSlaveMap(prev => {
      const n = new Map(prev);
      if (n.has(hwnd)) {
        n.delete(hwnd);
        addLog(`移除从窗口: ${truncate(title, 40)}`, "info");
      } else {
        n.set(hwnd, title);
        addLog(`添加从窗口: ${truncate(title, 40)}`, "info");
      }
      return n;
    });
  };

  const toggleTheme = () => {
    setThemeAnim(true);
    setTimeout(() => {
      const next = theme === 'dark' ? 'light' : 'dark';
      setTheme(next);
      localStorage.setItem('theme', next);
      setThemeAnim(false);
    }, 350);
  };


  const savePlan = useCallback((name: string) => {
    if (!masterHwnd) { addLog("请先选择主窗口才能保存方案", "error"); return; }
    const plan: SyncPlan = {
      id: Date.now().toString(),
      name: name || `方案${new Date().toLocaleString('zh-CN', {hour12:false})}`,
      masterHwnd, masterTitle,
      slaveMap: [...slaveMap.entries()],
      syncMouse, syncKeyboard,
      createdAt: new Date().toLocaleString('zh-CN', {hour12:false})
    };
    setPlans(prev => {
      const next = [...prev, plan];
      localStorage.setItem('sync-plans', JSON.stringify(next));
      return next;
    });
    addLog(`已保存方案: ${plan.name}`, "success");
  }, [masterHwnd, masterTitle, slaveMap, syncMouse, syncKeyboard, addLog]);

  const loadPlan = useCallback((plan: SyncPlan) => {
    setMasterHwnd(plan.masterHwnd);
    setMasterTitle(plan.masterTitle);
    setSlaveMap(new Map(plan.slaveMap));
    setSyncMouse(plan.syncMouse);
    setSyncKeyboard(plan.syncKeyboard);
    addLog(`已加载方案: ${plan.name}`, "success");
  }, [addLog]);

  const deletePlan = useCallback((id: string) => {
    setPlans(prev => {
      const next = prev.filter(p => p.id !== id);
      localStorage.setItem('sync-plans', JSON.stringify(next));
      return next;
    });
  }, []);

  // ── 快捷应用：选择文件 ─────────────────────────────────────────────────────
  const pickAndAddApp = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        title: '选择应用程序',
        filters: [
          { name: '应用程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        multiple: false,
      });
      if (!selected || typeof selected !== 'string') return;
      const path = selected as string;
      const name = path.split(/[\/]/).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, '') ?? '未命名';
      const sc: AppShortcut = {
        id: Date.now().toString(),
        name,
        path,
        args: '',
      };
      setAppShortcuts(prev => {
        const next = [...prev, sc];
        localStorage.setItem('app-shortcuts', JSON.stringify(next));
        return next;
      });
      addLog('已添加: ' + name, 'success');
    } catch (e) {
      addLog('选择文件失败: ' + e, 'error');
    }
  }, [addLog]);

  const addAppShortcut = useCallback(() => {
    if (!newAppPath.trim()) { addLog('请填写应用路径', 'error'); return; }
    const sc: AppShortcut = {
      id: Date.now().toString(),
      name: newAppName.trim() || newAppPath.split(/[\/]/).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, '') || '未命名',
      path: newAppPath.trim(),
      args: newAppArgs.trim(),
    };
    setAppShortcuts(prev => {
      const next = [...prev, sc];
      localStorage.setItem('app-shortcuts', JSON.stringify(next));
      return next;
    });
    setNewAppName(''); setNewAppPath(''); setNewAppArgs('');
    setShowAddApp(false);
    addLog('已添加: ' + sc.name, 'success');
  }, [newAppName, newAppPath, newAppArgs, addLog]);

  const removeAppShortcut = useCallback((id: string) => {
    setAppShortcuts(prev => {
      const next = prev.filter(s => s.id !== id);
      localStorage.setItem('app-shortcuts', JSON.stringify(next));
      return next;
    });
  }, []);

  const launchApp = useCallback(async (sc: AppShortcut) => {
    try {
      const args = sc.args ? sc.args.split(' ').filter(Boolean) : [];
      await invoke('launch_app', { path: sc.path, args });
      addLog('已启动: ' + sc.name, 'success');
    } catch (e) {
      addLog('启动失败: ' + sc.name + ' — ' + e, 'error');
    }
  }, [addLog]);


  const handleStartSync = async () => {
    if (!masterHwnd) { addLog("请先选择主窗口", "error"); return; }
    if (slaveMap.size === 0) { addLog("请至少选择一个从窗口", "error"); return; }
    setLoading(true);
    try {
      const result = await invoke<string>("start_sync", {
        config: {
          master_hwnd: masterHwnd,
          slave_hwnds: [...slaveMap.keys()],
          sync_mouse: syncMouse,
          sync_keyboard: syncKeyboard,
        }
      });
      setSyncActive(true);
      addLog(result, "success");
      setActiveTab("status");
    } catch (e) { addLog(`启动失败: ${e}`, "error"); }
    finally { setLoading(false); }
  };

  const handleStopSync = async () => {
    try { const r = await invoke<string>("stop_sync"); setSyncActive(false); addLog(r, "info"); }
    catch (e) { addLog(`停止失败: ${e}`, "error"); }
  };

  const handleFocus = async (hwnd: number) => {
    try { await invoke("focus_window", { hwnd }); } catch {}
  };

  const slaveEntries = [...slaveMap.entries()];

  return (
    <div className={`app theme-${theme}${themeAnim ? " theme-transition" : ""}`}>
      <TitleBar theme={theme} onToggleTheme={toggleTheme} />
      <div className="app-body">

        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-nav">
            <button className={`nav-btn${activeTab==="setup"?" active":""}`} onClick={() => setActiveTab("setup")}>
              <Settings size={15} /><span>配置</span>
            </button>
            <button className={`nav-btn${activeTab==="status"?" active":""}`} onClick={() => setActiveTab("status")}>
              <Zap size={15} /><span>状态</span>
              {syncActive && <span className="nav-dot" />}
            </button>
            <button className={`nav-btn${activeTab==="apps"?" active":""}`} onClick={() => setActiveTab("apps")}>
              <FolderOpen size={15} /><span>快捷应用</span>
            </button>

          </div>

          <div className="sidebar-section">
            <div className="section-title">同步选项</div>
            <label className="toggle-row">
              <MousePointer2 size={13} /><span>鼠标事件</span>
              <button className={`toggle${syncMouse?" on":""}`} onClick={() => setSyncMouse(v => !v)} />
            </label>
            <label className="toggle-row">
              <Keyboard size={13} /><span>键盘事件</span>
              <button className={`toggle${syncKeyboard?" on":""}`} onClick={() => setSyncKeyboard(v => !v)} />
            </label>
          </div>

          {/* 从窗口统计 */}
          <div className="sidebar-section">
            <div className="section-title">从窗口</div>
            <div className="slave-stat">
              <span className="slave-stat-num">{slaveMap.size}</span>
              <span className="slave-stat-label">个已选择</span>
            </div>
            {slaveMap.size > 0 && (
              <button className="clear-btn" onClick={() => setSlaveMap(new Map())}>
                <X size={11} /> 清空从窗口
              </button>
            )}
          </div>

          <div className="sidebar-actions">
            {!syncActive
              ? <button className="action-btn start" onClick={handleStartSync}
                  disabled={loading || !masterHwnd || slaveMap.size === 0}>
                  <Play size={13} />{loading ? "启动中…" : "开始同步"}
                </button>
              : <button className="action-btn stop" onClick={handleStopSync}>
                  <Square size={13} />停止同步
                </button>
            }
            <button className="action-btn save-plan" onClick={() => {
              const name = prompt('方案名称（留空自动命名）：', '') ?? '';
              savePlan(name);
            }}>
              <BookmarkPlus size={13} />保存方案
            </button>
            <button className={`action-btn plans-btn${showPlans ? ' active-plan' : ''}`} onClick={() => setShowPlans(v=>!v)}>
              <List size={13} />方案列表{plans.length > 0 && <span className="plan-count">{plans.length}</span>}
            </button>
            <button className="action-btn refresh" onClick={loadProcesses} disabled={refreshing}>
              <RefreshCw size={12} className={refreshing?"spin":""} />刷新进程
            </button>
          </div>

          <div className={`sync-indicator${syncActive?" active":""}`}>
            <div className="sync-dot" />
            <span>{syncActive ? "同步中" : "未启动"}</span>
          </div>

        </aside>

        {/* 方案列表面板 */}
        {showPlans && (
          <div className="plans-panel">
            <div className="plans-header">
              <span>已保存方案</span>
              <button className="plans-close" onClick={() => setShowPlans(false)}><X size={12}/></button>
            </div>
            <div className="plans-list">
              {plans.length === 0 && <div className="plans-empty">暂无保存的方案</div>}
              {plans.map(plan => (
                <div key={plan.id} className="plan-item">
                  <div className="plan-info">
                    <span className="plan-name">{plan.name}</span>
                    <span className="plan-meta">{plan.createdAt} · {plan.slaveMap.length}从窗口</span>
                  </div>
                  <div className="plan-actions">
                    <button className="plan-load" onClick={() => { loadPlan(plan); setShowPlans(false); }} title="加载此方案">
                      <Download size={11}/>
                    </button>
                    <button className="plan-del" onClick={() => deletePlan(plan.id)} title="删除">
                      <Trash2 size={11}/>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}


        {/* ── Main ── */}
        <main className="main-content">
          {activeTab === "setup" && (
            <div className="setup-view">
              <div className="setup-columns">
                <ProcPanel
                  processes={processes}
                  mode="single"
                  selectedHwnd={masterHwnd}
                  onSelectSingle={handleMasterSelect}
                  onKillProcess={handleKillProcess}
                  disabledHwnds={[...slaveSet]}
                  label="主窗口"
                  accentColor="#3b82f6"
                />
                <ProcPanel
                  processes={processes}
                  mode="multi"
                  selectedHwnds={slaveSet}
                  onToggleSlave={handleToggleSlave}
                  onKillProcess={handleKillProcess}
                  disabledHwnds={masterHwnd ? [masterHwnd] : []}
                  label="从窗口（可多选）"
                  accentColor="#10b981"
                />
              </div>

              <div className="selection-summary">
                <div className="sel-item master">
                  <Monitor size={13} />
                  <span className="sel-label">主窗口:</span>
                  <span className="sel-value">{masterTitle ? truncate(masterTitle, 32) : "未选择"}</span>
                </div>
                <div className="sel-arrow">→</div>
                <div className="sel-item slaves">
                  <Cpu size={13} />
                  <span className="sel-label">从窗口 ({slaveMap.size}):</span>
                  <span className="sel-value">
                    {slaveEntries.length > 0
                      ? slaveEntries.map(([,t]) => truncate(t, 18)).join("、")
                      : "未选择"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "status" && (
            <div className="status-view">
              <div className="status-cards">
                <div className={`status-card${syncActive?" active":""}`}>
                  <div className="status-card-icon"><Zap size={20}/></div>
                  <div><div className="status-card-title">同步状态</div>
                    <div className="status-card-value">{syncActive?"运行中":"已停止"}</div></div>
                </div>
                <div className="status-card">
                  <div className="status-card-icon blue"><Monitor size={20}/></div>
                  <div>
                    <div className="status-card-title">主窗口</div>
                    <div className="status-card-value">{masterTitle ? truncate(masterTitle,20) : "—"}</div>
                    {masterHwnd && <button className="focus-btn" onClick={() => handleFocus(masterHwnd)}>聚焦</button>}
                  </div>
                </div>
                <div className="status-card">
                  <div className="status-card-icon green"><Cpu size={20}/></div>
                  <div><div className="status-card-title">从窗口数</div>
                    <div className="status-card-value">{slaveMap.size} 个</div></div>
                </div>
                <div className={`status-card${syncMouse ? " card-on" : " card-off"}`}>
                  <div className={`status-card-icon${syncMouse ? " purple" : " off"}`}><MousePointer2 size={18}/></div>
                  <div><div className="status-card-title">鼠标同步</div>
                    <div className={`status-card-value${syncMouse ? " val-on" : " val-off"}`}>{syncMouse?"已启用":"已禁用"}</div></div>
                </div>
                <div className={`status-card${syncKeyboard ? " card-on" : " card-off"}`}>
                  <div className={`status-card-icon${syncKeyboard ? " orange" : " off"}`}><Keyboard size={18}/></div>
                  <div><div className="status-card-title">键盘同步</div>
                    <div className={`status-card-value${syncKeyboard ? " val-on" : " val-off"}`}>{syncKeyboard?"已启用":"已禁用"}</div></div>
                </div>
              </div>

              {slaveEntries.length > 0 && (
                <div className="slave-list-section">
                  <div className="section-header">从窗口列表</div>
                  <div className="slave-list">
                    {slaveEntries.map(([hwnd, title], i) => (
                      <div key={hwnd} className="slave-item">
                        <span className="slave-idx">{i+1}</span>
                        <span className="slave-title">{truncate(title, 44)}</span>
                        <span className="slave-hwnd">#{hwnd.toString(16).toUpperCase()}</span>
                        <button className="slave-focus" onClick={() => handleFocus(hwnd)}>聚焦</button>
                        <button className="slave-remove" onClick={() => {
                          setSlaveMap(prev => { const n = new Map(prev); n.delete(hwnd); return n; });
                        }}><X size={10}/></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "apps" && (
            <div className="apps-view">
              {/* 顶栏 */}
              <div className="apps-header">
                <span className="apps-title">快捷启动应用</span>
                <div className="apps-header-actions">
                  {appShortcuts.length > 0 && (
                    <button className="apps-launch-all-btn"
                      onClick={async () => { for (const sc of appShortcuts) { await launchApp(sc); } }}>
                      <PlayIcon size={13} /> 全部启动
                    </button>
                  )}
                  <button className="apps-pick-btn" onClick={pickAndAddApp} title="从文件系统选择应用">
                    <FolderOpen size={13} /> 选择应用
                  </button>
                  <button className="apps-add-btn" onClick={() => setShowAddApp(v=>!v)}>
                    <BookmarkPlus size={13} /> 手动输入
                  </button>
                </div>
              </div>

              {/* 手动添加表单 */}
              {showAddApp && (
                <div className="apps-add-form">
                  <div className="aaf-row">
                    <label>名称</label>
                    <input placeholder="应用名称（可选）" value={newAppName}
                      onChange={e=>setNewAppName(e.target.value)} />
                  </div>
                  <div className="aaf-row">
                    <label>路径</label>
                    <input placeholder="C:\path\to\app.exe" value={newAppPath}
                      onChange={e=>setNewAppPath(e.target.value)} />
                  </div>
                  <div className="aaf-row">
                    <label>参数</label>
                    <input placeholder="启动参数（可选）" value={newAppArgs}
                      onChange={e=>setNewAppArgs(e.target.value)} />
                  </div>
                  <div className="aaf-actions">
                    <button className="aaf-confirm" onClick={addAppShortcut}><BookmarkPlus size={12}/>确认添加</button>
                    <button className="aaf-cancel" onClick={()=>setShowAddApp(false)}>取消</button>
                  </div>
                </div>
              )}

              {/* 应用列表 */}
              <div className="apps-list">
                {appShortcuts.length === 0 && (
                  <div className="apps-empty">
                    <FolderOpen size={32} />
                    <span>还没有添加任何快捷应用</span>
                    <span className="apps-empty-sub">拖入桌面快捷方式或手动输入路径</span>
                  </div>
                )}
                {appShortcuts.map((sc, idx) => (
                  <div key={sc.id} className="app-item">
                    <div className="app-item-idx">{idx + 1}</div>
                    <div className="app-item-info">
                      <span className="app-item-name">{sc.name}</span>
                      <span className="app-item-path" title={sc.path}>{sc.path}</span>
                      {sc.args && <span className="app-item-args">参数: {sc.args}</span>}
                    </div>
                    <div className="app-item-actions">
                      <button className="app-launch-btn" onClick={() => launchApp(sc)}>
                        <PlayIcon size={12} /> 启动
                      </button>
                      <button className="app-del-btn" onClick={() => removeAppShortcut(sc.id)}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="log-panel">
            <div className="log-area">
              <div className="log-header"><Info size={11}/><span>运行日志</span></div>
              <div className="log-list" ref={logRef}>
                {log.length === 0 && <div className="log-empty">等待操作…</div>}
                {log.map((e,i) => (
                  <div key={i} className={`log-entry ${e.type}`}>
                    <span className="log-time">{e.time}</span>
                    <span className="log-msg">{e.msg}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="qr-side">
              <div className="qr-side-title">☕ 请开发者一杯奶茶</div>
              <img src={QR_CODE} alt="收款码" className="qr-side-img" />
              <div className="qr-side-hint">¥10 · 微信扫码</div>
            </div>
          </div>
        </main>
      </div>
        {themeAnim && <div className="theme-ripple"><div className="theme-ripple-circle" /></div>}
    </div>
  );
}
