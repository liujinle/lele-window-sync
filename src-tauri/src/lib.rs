//! 乐享同步操作 — 核心逻辑
//! 鼠标同步：PostMessageA 客户区坐标，不移动系统光标
//! 键盘同步：PostMessageA WM_KEYDOWN/WM_KEYUP，所有物理按键实时同步

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows,
    GetForegroundWindow, GetWindowLongA, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostMessageA,
    SetForegroundWindow, SetWindowsHookExA, ShowWindow, UnhookWindowsHookEx,
    GWL_STYLE, HHOOK, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, SW_RESTORE,
    WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WS_VISIBLE,
};

struct SafeHook(HHOOK);
unsafe impl Send for SafeHook {}
unsafe impl Sync for SafeHook {}

#[derive(Debug, Clone)]
enum SyncEvent {
    Mouse   { rel_x: i32, rel_y: i32, msg: u32, wheel_delta: i16 },
    KeyDown { vk: u32, scan: u32 },
    KeyUp   { vk: u32, scan: u32 },
}

struct SendTx(SyncSender<SyncEvent>);
unsafe impl Sync for SendTx {}

static SYNC_ACTIVE:   AtomicBool = AtomicBool::new(false);
static SYNC_MOUSE:    AtomicBool = AtomicBool::new(true);
static SYNC_KEYBOARD: AtomicBool = AtomicBool::new(true);
static MASTER_HWND:   AtomicI64  = AtomicI64::new(0);

static SLAVES:   Lazy<Mutex<Vec<i64>>>          = Lazy::new(|| Mutex::new(vec![]));
static KB_HOOK:  Lazy<Mutex<Option<SafeHook>>>  = Lazy::new(|| Mutex::new(None));
static MS_HOOK:  Lazy<Mutex<Option<SafeHook>>>  = Lazy::new(|| Mutex::new(None));
static APP:      Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));
static TX:       Lazy<Mutex<Option<SendTx>>>    = Lazy::new(|| Mutex::new(None));

#[inline]
fn enqueue(ev: SyncEvent) {
    if let Some(s) = TX.lock().as_ref() { let _ = s.0.try_send(ev); }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo  { pub hwnd: i64, pub title: String, pub pid: u32, pub visible: bool }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo { pub pid: u32, pub name: String, pub windows: Vec<WindowInfo> }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig  { pub master_hwnd: i64, pub slave_hwnds: Vec<i64>, pub sync_mouse: bool, pub sync_keyboard: bool }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus  { pub active: bool, pub master_hwnd: i64, pub slave_count: usize, pub sync_mouse: bool, pub sync_keyboard: bool }

struct EnumBuf { wins: Vec<WindowInfo> }

unsafe extern "system" fn enum_cb(hwnd: HWND, lp: LPARAM) -> BOOL {
    let buf = &mut *(lp.0 as *mut EnumBuf);
    if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }
    let mut tmp = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut tmp);
    if n == 0 { return BOOL(1); }
    let title = String::from_utf16_lossy(&tmp[..n as usize]).trim().to_string();
    if title.is_empty() { return BOOL(1); }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 { return BOOL(1); }
    if GetWindowLongA(hwnd, GWL_STYLE) as u32 & WS_VISIBLE.0 == 0 { return BOOL(1); }
    buf.wins.push(WindowInfo { hwnd: hwnd.0 as i64, title, pid, visible: true });
    BOOL(1)
}

#[tauri::command]
fn get_processes() -> Vec<ProcessInfo> {
    let mut map: HashMap<u32, ProcessInfo> = HashMap::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) { Ok(s)=>s, Err(_)=>return vec![] };
        let mut e = PROCESSENTRY32W::default();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let pid = e.th32ProcessID;
                let name = String::from_utf16_lossy(
                    &e.szExeFile.iter().take_while(|&&c|c!=0).cloned().collect::<Vec<_>>()
                ).to_string();
                map.insert(pid, ProcessInfo { pid, name, windows: vec![] });
                if Process32NextW(snap, &mut e).is_err() { break; }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
        let mut buf = EnumBuf { wins: vec![] };
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut buf as *mut _ as isize));
        for w in buf.wins { if let Some(p) = map.get_mut(&w.pid) { p.windows.push(w); } }
    }
    let mut v: Vec<ProcessInfo> = map.into_values().filter(|p|!p.windows.is_empty()).collect();
    v.sort_by(|a,b| a.name.cmp(&b.name));
    v
}

#[tauri::command]
fn get_windows() -> Vec<WindowInfo> {
    unsafe {
        let mut buf = EnumBuf { wins: vec![] };
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut buf as *mut _ as isize));
        buf.wins
    }
}

fn remove_hooks() {
    unsafe {
        if let Some(h) = KB_HOOK.lock().take() { let _ = UnhookWindowsHookEx(h.0); }
        if let Some(h) = MS_HOOK.lock().take() { let _ = UnhookWindowsHookEx(h.0); }
    }
    *TX.lock() = None;
}

fn emit_status() {
    if let Some(app) = APP.lock().as_ref() {
        let _ = app.emit("sync-status-changed", get_sync_status());
    }
}

fn start_worker(rx: Receiver<SyncEvent>) {
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            if !SYNC_ACTIVE.load(Ordering::Relaxed) { continue; }
            let slaves: Vec<i64> = SLAVES.lock().clone();
            unsafe {
                match ev {
                    SyncEvent::Mouse { rel_x, rel_y, msg, wheel_delta } => {
                        if !SYNC_MOUSE.load(Ordering::Relaxed) { continue; }
                        let lp = make_lp(rel_x, rel_y);
                        for &h in &slaves {
                            let s = HWND(h as *mut _);
                            if !IsWindow(s).as_bool() { continue; }
                            match msg {
                                m if m == WM_MOUSEMOVE   => { let _ = PostMessageA(s, WM_MOUSEMOVE,   WPARAM(0),      lp); }
                                m if m == WM_LBUTTONDOWN => { let _ = PostMessageA(s, WM_LBUTTONDOWN, WPARAM(0x0001), lp); }
                                m if m == WM_LBUTTONUP   => { let _ = PostMessageA(s, WM_LBUTTONUP,   WPARAM(0),      lp); }
                                m if m == WM_RBUTTONDOWN => { let _ = PostMessageA(s, WM_RBUTTONDOWN, WPARAM(0x0002), lp); }
                                m if m == WM_RBUTTONUP   => { let _ = PostMessageA(s, WM_RBUTTONUP,   WPARAM(0),      lp); }
                                m if m == WM_MBUTTONDOWN => { let _ = PostMessageA(s, WM_MBUTTONDOWN, WPARAM(0x0010), lp); }
                                m if m == WM_MBUTTONUP   => { let _ = PostMessageA(s, WM_MBUTTONUP,   WPARAM(0),      lp); }
                                m if m == WM_MOUSEWHEEL  => {
                                    let wp = ((wheel_delta as u32) << 16) as usize;
                                    let _ = PostMessageA(s, WM_MOUSEWHEEL, WPARAM(wp), lp);
                                }
                                _ => {}
                            }
                        }
                    }
                    SyncEvent::KeyDown { vk, scan } => {
                        if !SYNC_KEYBOARD.load(Ordering::Relaxed) { continue; }
                        for &h in &slaves {
                            let s = HWND(h as *mut _);
                            if IsWindow(s).as_bool() {
                                let lp = (1u32 | (scan << 16)) as isize;
                                let _ = PostMessageA(s, WM_KEYDOWN, WPARAM(vk as usize), LPARAM(lp));
                            }
                        }
                    }
                    SyncEvent::KeyUp { vk, scan } => {
                        if !SYNC_KEYBOARD.load(Ordering::Relaxed) { continue; }
                        for &h in &slaves {
                            let s = HWND(h as *mut _);
                            if IsWindow(s).as_bool() {
                                let lp = (0xC0000001u32 | (scan << 16)) as isize;
                                let _ = PostMessageA(s, WM_KEYUP, WPARAM(vk as usize), LPARAM(lp));
                            }
                        }
                    }
                }
            }
        }
    });
}

#[inline]
fn make_lp(x: i32, y: i32) -> LPARAM {
    LPARAM((((y as u16 as u32) << 16) | (x as u16 as u32)) as isize)
}

#[tauri::command]
fn start_sync(config: SyncConfig) -> Result<String, String> {
    if SYNC_ACTIVE.load(Ordering::Relaxed) {
        remove_hooks();
        SYNC_ACTIVE.store(false, Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if config.master_hwnd == 0       { return Err("请先选择主窗口".into()); }
    if config.slave_hwnds.is_empty() { return Err("请至少选择一个从窗口".into()); }

    MASTER_HWND.store(config.master_hwnd, Ordering::Relaxed);
    *SLAVES.lock() = config.slave_hwnds.clone();
    SYNC_MOUSE.store(config.sync_mouse, Ordering::Relaxed);
    SYNC_KEYBOARD.store(config.sync_keyboard, Ordering::Relaxed);

    let (tx, rx) = mpsc::sync_channel::<SyncEvent>(1024);
    *TX.lock() = Some(SendTx(tx));
    start_worker(rx);

    unsafe {
        if config.sync_keyboard {
            let h = SetWindowsHookExA(WH_KEYBOARD_LL, Some(kb_hook), None, 0)
                .map_err(|e| e.to_string())?;
            *KB_HOOK.lock() = Some(SafeHook(h));
        }
        if config.sync_mouse {
            let h = SetWindowsHookExA(WH_MOUSE_LL, Some(ms_hook), None, 0)
                .map_err(|e| e.to_string())?;
            *MS_HOOK.lock() = Some(SafeHook(h));
        }
    }

    SYNC_ACTIVE.store(true, Ordering::Relaxed);
    emit_status();
    Ok("同步已启动".into())
}

#[tauri::command]
fn stop_sync() -> Result<String, String> {
    remove_hooks();
    SYNC_ACTIVE.store(false, Ordering::Relaxed);
    emit_status();
    Ok("同步已停止".into())
}

#[tauri::command]
fn get_sync_status() -> SyncStatus {
    SyncStatus {
        active:        SYNC_ACTIVE.load(Ordering::Relaxed),
        master_hwnd:   MASTER_HWND.load(Ordering::Relaxed),
        slave_count:   SLAVES.lock().len(),
        sync_mouse:    SYNC_MOUSE.load(Ordering::Relaxed),
        sync_keyboard: SYNC_KEYBOARD.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn update_sync_options(sync_mouse: bool, sync_keyboard: bool) -> Result<(), String> {
    SYNC_MOUSE.store(sync_mouse, Ordering::Relaxed);
    SYNC_KEYBOARD.store(sync_keyboard, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn focus_window(hwnd: i64) -> Result<(), String> {
    unsafe {
        let h = HWND(hwnd as *mut _);
        if IsWindow(h).as_bool() {
            let _ = SetForegroundWindow(h);
            let _ = ShowWindow(h, SW_RESTORE);
        }
    }
    Ok(())
}

unsafe extern "system" fn ms_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && SYNC_ACTIVE.load(Ordering::Relaxed) && SYNC_MOUSE.load(Ordering::Relaxed) {
        let ms     = &*(lp.0 as *const MSLLHOOKSTRUCT);
        let master = HWND(MASTER_HWND.load(Ordering::Relaxed) as *mut _);
        if GetForegroundWindow() == master {
            let mut pt = POINT { x: ms.pt.x, y: ms.pt.y };
            let _ = ScreenToClient(master, &mut pt);
            let msg = wp.0 as u32;
            let wd  = if msg == WM_MOUSEWHEEL { (ms.mouseData >> 16) as i16 } else { 0 };
            enqueue(SyncEvent::Mouse { rel_x: pt.x, rel_y: pt.y, msg, wheel_delta: wd });
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

unsafe extern "system" fn kb_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && SYNC_ACTIVE.load(Ordering::Relaxed) && SYNC_KEYBOARD.load(Ordering::Relaxed) {
        let kb     = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        let master = HWND(MASTER_HWND.load(Ordering::Relaxed) as *mut _);
        if GetForegroundWindow() == master {
            let n = wp.0 as u32;
            if n == WM_KEYDOWN || n == WM_SYSKEYDOWN {
                enqueue(SyncEvent::KeyDown { vk: kb.vkCode, scan: kb.scanCode });
            } else if n == WM_KEYUP || n == WM_SYSKEYUP {
                enqueue(SyncEvent::KeyUp { vk: kb.vkCode, scan: kb.scanCode });
            }
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            *APP.lock() = Some(app.handle().clone());

            // 系统托盘
            #[cfg(target_os = "windows")]
            {
                use tauri::{
                    menu::{MenuBuilder, MenuItemBuilder},
                    tray::{TrayIconBuilder, TrayIconEvent},
                    Manager,
                };
                let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出程序").build(app)?;
                let menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("乐享同步操作")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::DoubleClick { .. } = event {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_processes, get_windows,
            start_sync, stop_sync, get_sync_status,
            update_sync_options, focus_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
