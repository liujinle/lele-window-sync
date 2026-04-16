<div align="center">

# 🎮 乐享同步操作 / LeXiang Window Sync

**Windows 多开游戏/应用同步利器 · Multi-window Input Synchronizer for Windows**

*基于 Tauri 2 + Rust + React 构建 · Built with Tauri 2 + Rust + React*

</div>

---

## 📖 简介 / Introduction

### 中文

**乐享同步操作** 是一款专为 Windows 多开场景设计的输入同步工具。选定主窗口后，所有鼠标点击、移动、滚轮及键盘按键操作将实时同步广播到所选的多个从窗口，让多开游戏、批量操作变得轻松高效。

### English

**LeXiang Window Sync** is an input synchronization tool designed for Windows multi-instance scenarios. After selecting a master window, all mouse clicks, movements, scroll wheel and keyboard operations are broadcast in real-time to all selected slave windows — making multi-instance gaming and batch operations effortless.

---

## ✨ 功能特性 / Features

| 功能 / Feature | 描述 / Description |
|---|---|
| 🖱️ **鼠标同步** / Mouse Sync | 移动、点击、滚轮实时同步，坐标精确映射<br>Real-time sync with accurate coordinate mapping |
| ⌨️ **键盘同步** / Keyboard Sync | 所有物理按键实时广播到从窗口<br>All physical keystrokes broadcast to slave windows |
| 🔍 **进程浏览器** / Process Browser | 实时枚举所有可见窗口，支持搜索过滤，PID 标注<br>Real-time enumeration with search filter and PID labels |
| 🔢 **无限从窗口** / Unlimited Slaves | 支持同时同步到多个从窗口，数量不限<br>Supports any number of slave windows simultaneously |
| 💾 **方案保存** / Save Presets | 保存/加载同步配置方案，本地持久化<br>Save/load sync configurations with local persistence |
| 🎯 **焦点感知** / Focus-Aware | 仅在主窗口处于前台时触发同步<br>Sync only triggers when master window is in foreground |
| 🌐 **中文支持** / Unicode Support | 进程名、窗口标题完整支持中文显示<br>Full Unicode support for Chinese process/window names |
| 🎨 **暗色界面** / Dark UI | 书法字体 + 科技感配色的精美暗色界面<br>Elegant dark UI with calligraphy fonts and tech colors |

---

## 🚀 快速开始 / Quick Start

### 环境要求 / Prerequisites

- **Windows 10 / 11** (x64)
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- [Node.js](https://nodejs.org/) 18+
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (含 MSVC + Windows SDK)

### 安装与运行 / Install & Run

```bash
# 克隆项目 / Clone project
git clone https://github.com/yourname/window-sync.git
cd window-sync

# 安装前端依赖 / Install frontend dependencies
npm install

# 开发模式 / Development mode
npm run tauri dev

# 生产构建 / Production build
npm run tauri build
# 输出路径 / Output: src-tauri/target/release/bundle/
```

---

## 📖 使用说明 / How to Use

### 中文步骤

1. **选择主窗口** — 在左侧「主窗口」面板展开进程，点击目标窗口选中（蓝色高亮）
2. **选择从窗口** — 在右侧「从窗口」面板选择一个或多个接收同步的窗口（绿色高亮，可多选）
3. **配置选项** — 在左侧边栏开关「鼠标事件」「键盘事件」
4. **开始同步** — 点击「开始同步」按钮，确保主窗口处于前台后进行操作
5. **保存方案** — 点击「保存方案」可将当前配置命名保存，下次一键加载

### English Steps

1. **Select Master** — Expand a process in the left "Master Window" panel, click a window to select it (blue highlight)
2. **Select Slaves** — In the right "Slave Windows" panel, select one or more target windows (green highlight, multi-select)
3. **Configure** — Toggle "Mouse Events" and "Keyboard Events" in the left sidebar
4. **Start Sync** — Click "Start Sync", then bring the master window to foreground and operate normally
5. **Save Preset** — Click "Save Preset" to name and save the current config for quick reloading

---

## ⚙️ 技术架构 / Technical Architecture

```
乐享同步操作
├── Frontend (React + TypeScript)
│   ├── 进程/窗口浏览器 (Process/Window Browser)
│   ├── 方案管理 (Preset Management - localStorage)
│   └── 实时状态监控 (Real-time Status Monitor)
└── Backend (Rust + Tauri 2)
    ├── WH_MOUSE_LL    → 鼠标 Hook → 队列 → PostMessageA (客户区坐标)
    ├── WH_KEYBOARD_LL → 键盘 Hook → 队列 → PostMessageA (WM_KEYDOWN/UP)
    ├── Process32W     → Unicode 进程枚举
    └── GetWindowTextW → Unicode 窗口标题
```

**设计要点 / Key Design Points:**
- Hook 回调内零锁、零阻塞，仅做 `try_send` 入队
- 独立工作线程消费事件，彻底避免死锁/卡死
- `ScreenToClient` 坐标转换，鼠标位置精确映射
- 有界信道（1024），队满丢弃不阻塞

---

## ⚠️ 注意事项 / Notes

- **中文输入同步**：由于游戏引擎通常不使用标准 Windows 消息处理 IME 输入，中文输入内容暂不支持同步；英文字符、数字、功能键、快捷键均可正常同步。
- **Chinese Input**: Game engines typically don't process IME input via standard Windows messages, so Chinese character input sync is not supported. English, numbers, function keys and shortcuts work normally.
- 部分带反作弊系统的游戏可能阻止消息注入，请自行评估风险。
- Some games with anti-cheat may block message injection — use at your own discretion.
- 建议以管理员权限运行以确保 Hook 安装成功。
- Run as Administrator is recommended for reliable hook installation.

---

## 🛠️ 依赖 / Dependencies

| 依赖 | 版本 | 用途 |
|------|------|------|
| tauri | 2.x | 跨平台桌面框架 |
| windows | 0.58 | Windows API 绑定 |
| parking_lot | 0.12 | 高性能互斥锁 |
| once_cell | 1.x | 懒初始化全局变量 |
| react | 18 | 前端 UI 框架 |
| lucide-react | 0.400 | 图标库 |

---

## ☕ 支持作者 / Support the Author

如果这个工具对你有帮助，欢迎请作者喝杯奶茶 🧋

If this tool helps you, feel free to buy the author a milk tea 🧋

<div align="center">
<img width="225" height="300" alt="mm_facetoface_collect_qrcode_1775815183119" src="https://github.com/user-attachments/assets/005db2dc-8d35-402a-90d4-7e15e45ad494" />


**微信扫码打赏 · WeChat Pay**

*-DROID-乐(\*\*乐)*
</div>

---

## 📄 License

MIT License © 2025 乐享同步操作

</div>
