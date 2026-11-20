import sys
import os
import json
import glob
import subprocess
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox
import ctypes
from datetime import datetime
import re
import urllib.request

# Windows 原生高 DPI 缩放感知
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

# 任务栏独立进程 AppId
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('postgull.monitor.panel')
except Exception:
    pass

# 默认用脚本自身所在目录，整个文件夹搬到哪都能跑。
# 需要指向别处时设环境变量 POSTGULL_HOME。
BASE_DIR = os.environ.get("POSTGULL_HOME") or os.path.dirname(os.path.abspath(__file__))
REG_PATH = os.path.join(BASE_DIR, "registry.json")
QUEUE_DIR = os.path.join(BASE_DIR, "queue")
ARCHIVE_PATH = os.path.join(QUEUE_DIR, "archive.jsonl")
ICO_PATH = os.path.join(BASE_DIR, "assets", "logo.ico")
# 标题栏与任务栏用的 PNG。Tk 的 PhotoImage 不认 ICO，只认 PNG/GIF，
# 而 iconbitmap 在部分环境会被忽略，所以两条路都准备一份。
LOGO_SMALL = os.path.join(BASE_DIR, "assets", "logo-28.png")
LOGO_LARGE = os.path.join(BASE_DIR, "assets", "logo-64.png")
# 投递走同目录下的 postgull.exe。它接受与开发期 relay.mjs 等价的参数：
#   postgull send --to X --from Y --summary Z --encoding base64  (正文走 stdin)
#   postgull flush <软件> --category <类别>
POSTGULL_EXE = os.path.join(BASE_DIR, "postgull.exe")

FONT_FAMILY = "Microsoft YaHei UI"

PROMPTS = {
    "dsh-bridge": "你是 dsh 的全新 bridge 跨软件桥接会话。请阅读本目录下的 README.md 与 registry.json，向旧 DSH Bridge 索要当前通信现状与启动提示词，完成自检后更新自身为活跃会话。",
    "dsh-work": "你是 dsh 的全新 work 任务对话。请阅读本目录下的 README.md 与 registry.json，向旧 DSH Work 索要任务进展与启动提示词，完成交接后更新自身为活跃会话。",
    "codex-bridge": "你是 codex 的全新 bridge 跨软件桥接会话。请阅读本目录下的 README.md 与 registry.json，向旧 codex Bridge（registry.json 里 codex / bridge 的上任会话，不是 dsh）索要通信现状与启动提示词，完成自检后更新自身为活跃会话。",
    "codex-work": "你是 codex 的全新 work 任务对话。请阅读本目录下的 README.md 与 registry.json，向旧 codex Work（registry.json 里 codex / work 的上任会话，不是 dsh）索要任务进展与启动提示词，完成交接后更新自身为活跃会话。",
    "agy-bridge": "你是 agy 的全新 bridge 跨软件桥接会话。请阅读本目录下的 README.md 与 registry.json，向旧 agy Bridge（registry.json 里 agy / bridge 的上任会话，不是 dsh）索要通信现状与启动提示词，保持界面打开后更新自身为活跃会话。",
    "agy-work": "你是 agy 的全新 work 任务对话。请阅读本目录下的 README.md 与 registry.json，向旧 agy Work（registry.json 里 agy / work 的上任会话，不是 dsh）索要任务进展与启动提示词，完成交接后更新自身为活跃会话。"
}

def normalize_name(raw_name):
    if not raw_name:
        return "未知"
    s = str(raw_name).lower()
    sw = "dsh" if "dsh" in s or "deepseek" in s else ("codex" if "codex" in s else ("agy" if "agy" in s or "gemini" in s or "antigravity" in s else "other"))
    cat = "bridge" if "bridge" in s or "桥接" in s else ("work" if "work" in s or "任务" in s or "协同" in s else "")
    if sw != "other" and cat:
        return f"{sw}({cat})"
    if sw != "other":
        return sw
    return raw_name[:12]

# 苹果经典圆角胶囊开关组件
class IOSSwitch(tk.Canvas):
    def __init__(self, parent, width=54, height=28, bg_color="#0d1117", on_change=None):
        super().__init__(parent, width=width, height=height, bg=bg_color, highlightthickness=0, cursor="hand2")
        self.w = width
        self.h = height
        self.r = height // 2
        self.state = False
        self.on_change = on_change
        
        self.col_off_track = "#30363d"
        self.col_on_track = "#34c759"
        self.col_thumb = "#ffffff"
        
        self.bind("<Button-1>", self.toggle)
        self.draw()

    def set_state(self, val, trigger_callback=False):
        if self.state != val:
            self.state = val
            self.draw()
            if trigger_callback and self.on_change:
                self.on_change(self.state)

    def toggle(self, event=None):
        self.state = not self.state
        self.draw()
        if self.on_change:
            self.on_change(self.state)

    def draw(self):
        self.delete("all")
        track_color = self.col_on_track if self.state else self.col_off_track
        self.create_oval(0, 0, self.h, self.h, fill=track_color, outline="")
        self.create_oval(self.w - self.h, 0, self.w, self.h, fill=track_color, outline="")
        self.create_rectangle(self.r, 0, self.w - self.r, self.h, fill=track_color, outline="")
        
        pad = 2
        d = self.h - (pad * 2)
        if self.state:
            x0 = self.w - self.h + pad
        else:
            x0 = pad
        y0 = pad
        self.create_oval(x0, y0, x0 + d, y0 + d, fill=self.col_thumb, outline="")

# 消息详情与打回弹窗
class MessageDetailDialog(tk.Toplevel):
    def __init__(self, parent, item, on_rejected_callback=None, on_deleted_callback=None):
        super().__init__(parent)
        self.title("信箱消息详情与处置")
        self.item = item
        self.on_rejected_callback = on_rejected_callback
        self.on_deleted_callback = on_deleted_callback
        
        w, h = 640, 720
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        x = max(50, (sw - w) // 2)
        y = max(50, (sh - h) // 2)
        self.geometry(f"{w}x{h}+{x}+{y}")
        self.minsize(580, 600)
        
        self.c_bg = "#0d1117"
        self.c_card = "#161b22"
        self.c_border = "#30363d"
        self.c_fg = "#c9d1d9"
        self.c_dim = "#8b949e"
        self.c_blue = "#58a6ff"
        self.c_red = "#f85149"
        self.c_btn = "#21262d"
        
        self.configure(bg=self.c_bg)
        self.transient(parent)
        self.grab_set()
        
        self.setup_ui()

    def setup_ui(self):
        pad_frame = tk.Frame(self, bg=self.c_bg, padx=20, pady=16)
        pad_frame.pack(fill="both", expand=True)
        
        # 1. 顶部基础元数据卡片
        meta_card = tk.Frame(pad_frame, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, padx=14, pady=10)
        meta_card.pack(fill="x", pady=(0, 12))
        
        f_from = normalize_name(self.item.get("from", "未知"))
        f_to = normalize_name(self.item.get("to", "未知"))
        f_token = self.item.get("token", "未知")
        f_time = self.item.get("createdAt", "")
        
        r1 = tk.Frame(meta_card, bg=self.c_card)
        r1.pack(fill="x")
        tk.Label(r1, text=f"路由: {f_from}  ➔  {f_to}", font=(FONT_FAMILY, 11, "bold"), bg=self.c_card, fg=self.c_blue).pack(side="left")
        tk.Label(r1, text=f_time[:19].replace("T", " "), font=(FONT_FAMILY, 10), bg=self.c_card, fg=self.c_dim).pack(side="right")
        
        r2 = tk.Frame(meta_card, bg=self.c_card)
        r2.pack(fill="x", pady=(4, 0))
        tk.Label(r2, text=f"凭证 Token: {f_token}", font=(FONT_FAMILY, 9), bg=self.c_card, fg=self.c_dim).pack(side="left")
        
        reason = self.item.get("sleepReason", "")
        if reason:
            tk.Label(meta_card, text=f"暂存原因: {reason}", font=(FONT_FAMILY, 9), bg=self.c_card, fg="#d29922", anchor="w").pack(fill="x", pady=(4, 0))

        # 底部按钮区先 pack 到底部，再让正文区占据剩余空间。
        # 顺序很关键：正文区若带 expand=True 且先 pack，会把底部挤出可视区，
        # 实测超出 454 px，按钮看不到也点不到。
        reject_card = tk.Frame(pad_frame, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, padx=14, pady=12)
        reject_card.pack(side="bottom", fill="x", pady=(12, 0))

        # 2. 完整内容可滚动阅读区（装进剩下的空间）
        tk.Label(pad_frame, text="完整消息正文 (可上下滑动查看)", font=(FONT_FAMILY, 10, "bold"), bg=self.c_bg, fg=self.c_dim).pack(side="top", anchor="w", pady=(0, 4))

        content_card = tk.Frame(pad_frame, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1)
        content_card.pack(side="top", fill="both", expand=True, pady=(0, 0))
        
        self.txt_content = tk.Text(
            content_card, bg=self.c_card, fg=self.c_fg, font=(FONT_FAMILY, 10),
            wrap="word", relief="flat", padx=12, pady=10, highlightthickness=0,
            # 显式给小的默认高度：Text 默认 24 行，会让内容区请求 744 px，
            # 把底部按钮区挤出窗口。给 8 行后总需求落在窗口内，
            # 实际显示高度仍由 fill/expand 撑满剩余空间。
            height=8, width=40,
        )
        sb = ttk.Scrollbar(content_card, orient="vertical", command=self.txt_content.yview)
        self.txt_content.configure(yscrollcommand=sb.set)
        
        self.txt_content.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        
        full_text = self.item.get("finalText", "") or self.item.get("body", "") or self.item.get("summary", "")
        self.txt_content.insert("1.0", full_text)
        self.txt_content.config(state="disabled")

        # 3. 打回与反馈控制区（沿用上面已 pack 到底部的那个 reject_card）
        tk.Label(reject_card, text="打回与处置 (Reject & Return)", font=(FONT_FAMILY, 10, "bold"), bg=self.c_card, fg=self.c_red).pack(anchor="w", pady=(0, 6))
        
        # 快捷理由标签按钮
        tag_frame = tk.Frame(reject_card, bg=self.c_card)
        tag_frame.pack(fill="x", pady=(0, 6))
        
        tk.Label(tag_frame, text="快捷理由:", font=(FONT_FAMILY, 9), bg=self.c_card, fg=self.c_dim).pack(side="left", padx=(0, 6))
        
        quick_reasons = [
            "发往了错的对话",
            "这个agent暂时不会醒来",
            "这条消息不重要",
            "后续和别的消息一起发出即可"
        ]
        for qr in quick_reasons:
            btn_qr = tk.Button(
                tag_frame, text=qr, font=(FONT_FAMILY, 8), bg=self.c_btn, fg=self.c_fg,
                relief="flat", highlightbackground=self.c_border, highlightthickness=1,
                padx=6, pady=2, cursor="hand2",
                command=lambda r=qr: self.set_reason(r)
            )
            btn_qr.pack(side="left", padx=3)

        # 提示词输入框
        input_row = tk.Frame(reject_card, bg=self.c_card)
        input_row.pack(fill="x", pady=(4, 8))
        
        self.ent_reason = tk.Entry(
            input_row, font=(FONT_FAMILY, 10), bg="#0d1117", fg=self.c_fg,
            relief="flat", highlightbackground=self.c_border, highlightthickness=1,
            insertbackground=self.c_fg
        )
        self.ent_reason.pack(side="left", fill="x", expand=True, ipady=4, padx=(0, 10))
        
        # 打回按钮
        btn_reject = tk.Button(
            input_row, text="❌ 确认打回", font=(FONT_FAMILY, 10, "bold"),
            bg="#b62324", fg="#ffffff", activebackground="#f85149", activeforeground="#ffffff",
            relief="flat", padx=14, pady=4, cursor="hand2",
            command=self.confirm_reject
        )
        btn_reject.pack(side="right")

        # 直接删除：不打回、不通知发送方，直接从信箱丢掉。
        # 打回适合「发错目标，要让对方知道」，删除适合「这条本来就是多余的」。
        del_row = tk.Frame(reject_card, bg=self.c_card)
        del_row.pack(fill="x", pady=(8, 0))

        tk.Label(
            del_row, text="删掉这条不会通知发送方，消息正文也不归档。",
            font=(FONT_FAMILY, 9), bg=self.c_card, fg=self.c_dim, anchor="w"
        ).pack(side="left")

        btn_delete = tk.Button(
            del_row, text="🗑 直接删除", font=(FONT_FAMILY, 10, "bold"),
            bg=self.c_btn, fg=self.c_red, activebackground="#30363d", activeforeground="#ffffff",
            relief="flat", highlightbackground=self.c_border, highlightthickness=1,
            padx=14, pady=4, cursor="hand2",
            command=self.confirm_delete
        )
        btn_delete.pack(side="right")

    def set_reason(self, text):
        self.ent_reason.delete(0, tk.END)
        self.ent_reason.insert(0, text)

    def confirm_reject(self):
        reason = self.ent_reason.get().strip()
        f_from = self.item.get("from", "发送方")
        token = self.item.get("token", "未知")
        
        confirm_text = f"确定要打回此消息给 [{f_from}] 吗？\n\n凭证: {token}\n附加理由: {reason if reason else '（未附额外说明）'}"
        if not messagebox.askyesno("确认打回", confirm_text, parent=self):
            return
            
        # 执行打回操作
        if self.on_rejected_callback:
            self.on_rejected_callback(self.item, reason)
        self.destroy()

    def confirm_delete(self):
        token = self.item.get("token", "未知")
        f_to = normalize_name(self.item.get("to", "未知"))
        raw_summary = str(self.item.get("summary", "") or "").replace("\n", " ")
        summary = raw_summary[:60] + ("…" if len(raw_summary) > 60 else "")

        confirm_text = (
            f"确定直接删除这条消息吗？\n\n"
            f"凭证: {token}\n"
            f"收件方: {f_to}\n"
            f"摘要: {summary}\n\n"
            f"不会通知发送方，正文也不会写进归档。删掉后无法恢复。"
        )
        if not messagebox.askyesno("确认删除", confirm_text, parent=self):
            return

        if self.on_deleted_callback:
            self.on_deleted_callback(self.item)
        self.destroy()

class BridgeMonitorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("PostGull 信鸥 监控面板")
        
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        w = min(1054, int(sw * 0.92))
        h = min(1156, int(sh * 0.92))
        x = max(20, (sw - w) // 2)
        y = max(20, (sh - h) // 2)
        self.geometry(f"{w}x{h}+{x}+{y}")
        self.minsize(800, 750)
        
        # 配色
        self.c_bg = "#0d1117"
        self.c_card = "#161b22"
        self.c_border = "#30363d"
        self.c_fg = "#c9d1d9"
        self.c_dim = "#8b949e"
        self.c_blue = "#58a6ff"
        self.c_green = "#3fb950"
        self.c_yellow = "#d29922"
        self.c_btn = "#21262d"
        self.c_btn_hover = "#30363d"
        
        self.configure(bg=self.c_bg)
        
        if os.path.exists(ICO_PATH):
            try:
                self.iconbitmap(ICO_PATH)
            except Exception:
                pass

        # 任务栏与标题栏图标。iconbitmap 只认 .ico，且部分环境下会被忽略，
        # 再用 PNG 设一次大图标，两条路都走一遍。
        # Tk 8.6 原生支持 PNG，不需要 Pillow。
        #
        # 尺寸说明：iconphoto 给的是 64px 那版，系统自己缩放到任务栏尺寸，
        # 比先缩到 28 再放大清晰。标题栏单独用 28px 那版，直接按原尺寸贴，不缩放。
        if os.path.exists(LOGO_LARGE):
            try:
                big = tk.PhotoImage(file=LOGO_LARGE)
                self.iconphoto(True, big)
                self._icon_ref = big  # 留住引用，否则会被回收，图标变空白
            except Exception:
                pass
        if os.path.exists(LOGO_SMALL):
            try:
                self._logo_img = tk.PhotoImage(file=LOGO_SMALL)
            except Exception:
                self._logo_img = None

        self.current_filter = "全部"
        self.all_queue_items = []
        self._last_rendered_fingerprint = ""
        self._last_sessions_fingerprint = ""
        self.is_human_sleeping = False
        
        # 自动派发/自动接收控制（防并发与防抖）
        self._flushing_targets = set()
        # CDP 端口缓存。探测一次约几百毫秒，2.5 秒轮询不能每次都扫进程。
        self._cdp_port = None
        self._cdp_port_at = 0.0
        self._last_flush_time = {}
        
        self.setup_ui()
        self.poll_data()

    def setup_ui(self):
        # 1. 顶部 Header
        header = tk.Frame(self, bg=self.c_bg, padx=24, pady=14)
        header.pack(fill="x")
        
        tbox = tk.Frame(header, bg=self.c_bg)
        tbox.pack(side="left")
        # 标题栏用真实图标，不用 emoji：🕊 在不同字体下渲染差别大，
        # Windows 上常显示成黑白方块。
        if getattr(self, "_logo_img", None) is not None:
            tk.Label(tbox, image=self._logo_img, bg=self.c_bg).pack(side="left", padx=(0, 10))
        tk.Label(tbox, text="PostGull 信鸥", font=(FONT_FAMILY, 16, "bold"), bg=self.c_bg, fg=self.c_blue).pack(side="left")
        
        right_ctrl = tk.Frame(header, bg=self.c_bg)
        right_ctrl.pack(side="right")
        
        sleep_box = tk.Frame(right_ctrl, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, padx=12, pady=4)
        sleep_box.pack(side="left", padx=(0, 14))
        
        self.lbl_sleep_text = tk.Label(sleep_box, text="人类在线", font=(FONT_FAMILY, 10, "bold"), bg=self.c_card, fg=self.c_fg)
        self.lbl_sleep_text.pack(side="left", padx=(0, 8))
        
        self.switch_sleep = IOSSwitch(sleep_box, width=50, height=26, bg_color=self.c_card, on_change=self.on_human_sleep_toggle)
        self.switch_sleep.pack(side="left")
        
        self.lbl_pill = tk.Label(right_ctrl, text="● 0% CPU/GPU", font=(FONT_FAMILY, 11, "bold"), bg="#1a2e20", fg=self.c_green, padx=12, pady=4)
        self.lbl_pill.pack(side="left")
        
        # 2. 选项卡导航栏
        tab_nav = tk.Frame(self, bg=self.c_bg, padx=24)
        tab_nav.pack(fill="x")
        
        self.btn_tab1 = tk.Button(
            tab_nav, text="协作节点 (6)", font=(FONT_FAMILY, 12, "bold"),
            bg=self.c_card, fg=self.c_blue, relief="flat", padx=20, pady=8,
            highlightbackground=self.c_border, highlightthickness=1, cursor="hand2",
            command=lambda: self.switch_tab(1)
        )
        self.btn_tab1.pack(side="left", padx=(0, 8))
        
        self.btn_tab2 = tk.Button(
            tab_nav, text="信箱暂存区 (0)", font=(FONT_FAMILY, 12, "bold"),
            bg=self.c_bg, fg=self.c_dim, relief="flat", padx=20, pady=8,
            highlightbackground=self.c_border, highlightthickness=1, cursor="hand2",
            command=lambda: self.switch_tab(2)
        )
        self.btn_tab2.pack(side="left")
        
        tk.Frame(self, bg=self.c_border, height=1).pack(fill="x", padx=24, pady=(6, 0))
        
        # 3. 页面容器
        self.page_container = tk.Frame(self, bg=self.c_bg, padx=24, pady=16)
        self.page_container.pack(fill="both", expand=True)
        
        # === Page 1: 协作节点 ===
        self.page1 = tk.Frame(self.page_container, bg=self.c_bg)
        
        self.banner_sleeping = tk.Frame(self.page1, bg="#271d0e", highlightbackground=self.c_yellow, highlightthickness=1, padx=16, pady=8)
        tk.Label(
            self.banner_sleeping, 
            text="🌙 人类休眠模式已激活：所有 AI 对话请自主决策推演，严禁挂起阻塞等待用户反馈！严禁让 GPU/推演进程闲置！", 
            font=(FONT_FAMILY, 10, "bold"), bg="#271d0e", fg=self.c_yellow
        ).pack(side="left")
        
        self.session_cards = []
        for i in range(6):
            card = tk.Frame(self.page1, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, padx=18, pady=12)
            card.pack(fill="x", pady=6)
            
            left = tk.Frame(card, bg=self.c_card)
            left.pack(side="left", fill="y")
            dot = tk.Label(left, text="●", font=(FONT_FAMILY, 13), bg=self.c_card, fg="#6e7681")
            dot.pack(side="left", padx=(0, 10))
            name = tk.Label(left, text="...", font=(FONT_FAMILY, 13, "bold"), bg=self.c_card, fg=self.c_fg)
            name.pack(side="left")
            
            right = tk.Frame(card, bg=self.c_card)
            right.pack(side="right")
            
            btn_id = tk.Button(
                right, text="...", font=(FONT_FAMILY, 11), bg="#0d1117", fg=self.c_blue,
                activebackground=self.c_blue, activeforeground="#ffffff",
                relief="flat", highlightbackground=self.c_border, highlightthickness=1,
                padx=14, pady=4, cursor="hand2"
            )
            btn_id.pack(side="left", padx=(0, 12))
            
            btn_new = tk.Button(
                right, text="新对话", font=(FONT_FAMILY, 11, "bold"),
                bg=self.c_btn, fg=self.c_fg, activebackground=self.c_blue, activeforeground="#ffffff",
                relief="flat", highlightbackground=self.c_border, highlightthickness=1,
                padx=16, pady=4, cursor="hand2"
            )
            btn_new.pack(side="left")
            
            self.session_cards.append({
                "card": card,
                "dot": dot,
                "name": name,
                "btn_id": btn_id,
                "btn_new": btn_new,
                "full_id": "",
                "key": ""
            })
            
        # === Page 2: 信箱暂存区 (300px 筛选栏) ===
        self.page2 = tk.Frame(self.page_container, bg=self.c_bg)
        
        self.filter_bar = tk.Frame(self.page2, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, width=300, padx=12, pady=12)
        self.filter_bar.pack(side="left", fill="y", padx=(0, 14))
        self.filter_bar.pack_propagate(False)
        
        tk.Label(self.filter_bar, text="接收方筛选", font=(FONT_FAMILY, 12, "bold"), bg=self.c_card, fg=self.c_dim).pack(anchor="w", pady=(0, 10))
        
        self.filter_rows = {}
        filters = ["全部", "dsh(bridge)", "dsh(work)", "codex(bridge)", "codex(work)", "agy(bridge)", "agy(work)"]
        for f in filters:
            row = tk.Frame(self.filter_bar, bg=self.c_btn if f != "全部" else self.c_blue, cursor="hand2", padx=10, pady=8)
            row.pack(fill="x", pady=4)
            
            lbl_badge = tk.Label(row, text="", font=(FONT_FAMILY, 11, "bold"), bg=row["bg"], fg=self.c_yellow)
            lbl_badge.pack(side="left")
            
            lbl_text = tk.Label(row, text=f, font=(FONT_FAMILY, 11, "bold" if f == "全部" else "normal"),
                                bg=row["bg"], fg="#ffffff" if f == "全部" else self.c_fg)
            lbl_text.pack(side="left", padx=(4, 0))
            
            for w in (row, lbl_badge, lbl_text):
                w.bind("<Button-1>", lambda e, target=f: self.apply_filter(target))
                
            self.filter_rows[f] = {
                "frame": row,
                "badge": lbl_badge,
                "text": lbl_text
            }

        self.queue_box = tk.Frame(self.page2, bg=self.c_card, highlightbackground=self.c_border, highlightthickness=1, padx=14, pady=12)
        self.queue_box.pack(side="right", fill="both", expand=True)
        
        self.q_canvas = tk.Canvas(self.queue_box, bg=self.c_card, highlightthickness=0)
        self.q_scrollbar = ttk.Scrollbar(self.queue_box, orient="vertical", command=self.q_canvas.yview)
        self.q_scrollable_frame = tk.Frame(self.q_canvas, bg=self.c_card)
        
        self.q_scrollable_frame.bind(
            "<Configure>",
            lambda e: self.q_canvas.configure(scrollregion=self.q_canvas.bbox("all"))
        )
        self.q_canvas_window = self.q_canvas.create_window((0, 0), window=self.q_scrollable_frame, anchor="nw")
        self.q_canvas.bind("<Configure>", lambda e: self.q_canvas.itemconfig(self.q_canvas_window, width=e.width))
        self.q_canvas.configure(yscrollcommand=self.q_scrollbar.set)
        
        self.q_canvas.pack(side="left", fill="both", expand=True)
        self.q_scrollbar.pack(side="right", fill="y")
        
        self.page1.pack(fill="both", expand=True)

        self.lbl_toast = tk.Label(self, text="✓ 提示词已成功复制到系统剪贴板！", font=(FONT_FAMILY, 11, "bold"), bg="#238636", fg="#ffffff", pady=8)
        
        footer = tk.Frame(self, bg=self.c_bg, padx=24, pady=8)
        footer.pack(side="bottom", fill="x")
        self.lbl_footer = tk.Label(footer, text="数据源: registry.json + queue/*.jsonl | 自动无闪烁同步", font=(FONT_FAMILY, 10), bg=self.c_bg, fg="#484f58")
        self.lbl_footer.pack(side="left")

    def on_human_sleep_toggle(self, is_on):
        self.is_human_sleeping = is_on
        if is_on:
            self.lbl_sleep_text.config(text="🌙 休眠中", fg=self.c_yellow)
            self.banner_sleeping.pack(fill="x", pady=(0, 8), before=self.session_cards[0]["card"])
            toast_msg = "🌙 人类休眠模式已开启：已写入 registry.json"
            note = "人类已入睡/休眠。所有 AI 对话自主推进任务，遇到决策点自行权衡选择最优方案推进，严禁闲置等待人类反馈！务必保持 GPU 推演与大任务连续运转。"
        else:
            self.lbl_sleep_text.config(text="人类在线", fg=self.c_fg)
            self.banner_sleeping.pack_forget()
            toast_msg = "☀️ 人类在线模式已恢复：已更新 registry.json"
            note = "人类已在线。可正常请求用户确认与交互。"
            
        try:
            if os.path.exists(REG_PATH):
                with open(REG_PATH, "r", encoding="utf-8") as f:
                    reg_data = json.load(f)
                reg_data["humanSleeping"] = is_on
                reg_data["humanSleepingSince"] = datetime.now().isoformat() if is_on else None
                reg_data["humanSleepingNote"] = note
                with open(REG_PATH, "w", encoding="utf-8") as f:
                    json.dump(reg_data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
            
        self.copy_text("", toast_msg)

    def switch_tab(self, tab_num):
        if tab_num == 1:
            self.page2.pack_forget()
            self.page1.pack(fill="both", expand=True)
            self.btn_tab1.config(bg=self.c_card, fg=self.c_blue)
            self.btn_tab2.config(bg=self.c_bg, fg=self.c_dim)
        else:
            self.page1.pack_forget()
            self.page2.pack(fill="both", expand=True)
            self.btn_tab2.config(bg=self.c_card, fg=self.c_blue)
            self.btn_tab1.config(bg=self.c_bg, fg=self.c_dim)

    def apply_filter(self, target):
        self.current_filter = target
        for f, obj in self.filter_rows.items():
            is_active = (f == target)
            bg_col = self.c_blue if is_active else self.c_btn
            fg_col = "#ffffff" if is_active else self.c_fg
            obj["frame"].config(bg=bg_col)
            obj["badge"].config(bg=bg_col)
            obj["text"].config(bg=bg_col, fg=fg_col)
        self.render_queue_items(force=True)

    def copy_text(self, text, msg):
        if text:
            self.clipboard_clear()
            self.clipboard_append(text)
            self.update()
        self.lbl_toast.config(text=msg)
        self.lbl_toast.pack(fill="x", side="bottom")
        self.after(2000, lambda: self.lbl_toast.pack_forget())

    def open_detail_dialog(self, item):
        MessageDetailDialog(
            self, item,
            on_rejected_callback=self.handle_reject_message,
            on_deleted_callback=self.handle_delete_message,
        )

    def handle_delete_message(self, item):
        """直接从信箱删掉一条消息，不通知发送方，不写归档。

        与打回的区别：打回是「发错地方了，要让对方知道」，会向发送方发一条说明；
        删除是「这条本来就多余」，静默丢弃。比如重复通知、测试残留。
        """
        token = item.get("token")
        msg_id = item.get("id")
        file_path = item.get("_file_path")

        if not file_path or not os.path.exists(file_path):
            messagebox.showerror("删除失败", f"找不到队列文件：{file_path}", parent=self)
            return

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            kept = []
            removed = 0
            for l in lines:
                if not l.strip():
                    continue
                try:
                    d = json.loads(l)
                except Exception:
                    kept.append(l)
                    continue
                # 优先按 token 匹配（唯一），没有 token 再退回 id。
                hit = (token and d.get("token") == token) or (
                    not token and msg_id and d.get("id") == msg_id
                )
                if hit:
                    removed += 1
                else:
                    kept.append(l)

            if removed == 0:
                messagebox.showwarning(
                    "没有找到",
                    f"队列文件里没有匹配的记录，可能已被其他进程取走。\n凭证: {token}",
                    parent=self
                )
                self.scan_queue()
                return

            # 原子写：先写临时文件再替换，避免写一半崩溃留下残缺队列。
            tmp = file_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(kept)
            os.replace(tmp, file_path)

            self.copy_text("", f"🗑 已删除 {removed} 条，凭证 {token}（未通知发送方）")
        except Exception as err:
            messagebox.showerror("删除失败", f"删除时出错: {err}", parent=self)
            return

        self.scan_queue()

    def handle_reject_message(self, item, reason):
        msg_id = item.get("id")
        f_from = item.get("from", "未知")
        token = item.get("token", "未知")
        summary = item.get("summary", "无摘要")
        file_path = item.get("_file_path")
        
        # 1. 从源队列文件中移除该条目，并归档为 rejected
        try:
            if file_path and os.path.exists(file_path):
                with open(file_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                kept = []
                for l in lines:
                    if not l.strip(): continue
                    try:
                        d = json.loads(l)
                        if d.get("id") != msg_id:
                            kept.append(l)
                    except Exception:
                        kept.append(l)
                with open(file_path, "w", encoding="utf-8") as f:
                    f.writelines(kept)
            
            # 追加到 archive.jsonl，标记为 rejected
            archived = dict(item)
            archived.pop("_file_path", None)
            archived["status"] = "rejected"
            archived["rejectedAt"] = datetime.now().isoformat()
            archived["rejectReason"] = reason
            with open(ARCHIVE_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(archived, ensure_ascii=False) + "\n")
        except Exception as err:
            messagebox.showerror("文件处理失败", f"打回失败: {err}", parent=self)
            return

        # 2. 向发送方自动发送一条打回说明通知
        try:
            # 推测发送方对应的目标
            norm_from = normalize_name(f_from).lower()
            target_to = "dsh"
            if "codex" in norm_from:
                target_to = "codex"
            elif "agy" in norm_from:
                target_to = "agy"
                
            reject_summary = f"打回通知：你发送的消息 [{token}] 已被人类拦截打回。理由：{reason if reason else '无额外说明'}"
            reject_body = (
                f"【消息已被人类从信箱打回】\n\n"
                f"原消息凭证: {token}\n"
                f"原消息摘要: {summary}\n"
                f"打回理由/提示词: {reason if reason else '无额外说明'}\n\n"
                f"该消息已被移出待办队列并归档。请根据打回原因调整发送目标或后续计划。"
            )
            
            # 使用 Node.js relay 机制发回通知
            from base64 import b64encode
            b64 = b64encode(reject_body.encode("utf-8")).decode("ascii")
            
            cmd = [
                POSTGULL_EXE, "send",
                "--to", target_to,
                "--from", "PostGull 监控面板",
                "--summary", reject_summary[:280],
                "--encoding", "base64",
            ]
            
            subprocess.Popen(
                cmd,
                input=b64.encode("ascii"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            
            self.copy_text("", f"❌ 消息已成功打回，并已向 {f_from} 发出回执！")
        except Exception as e:
            self.copy_text("", f"❌ 消息已打回并归档（回执发送遇到轻微异常: {e}）")

        # 立即重新扫描刷新
        self.scan_queue()

    def find_cdp_port(self):
        """找一个真正可用的 Antigravity CDP 端口。

        只读 DevToolsActivePort 文件不够用，实测三类失效：
          1. 启动时没带 --remote-debugging-port，文件根本不生成；
          2. 带的是 =0，端口随机，文件被删就读不到；
          3. 文件是上次运行留下的，端口早被别的进程占用。
        所以按三条线索依次找，判定标准是 /json/version 返回带 Browser 的 JSON。
        Antigravity 自己的认证服务返回 401，web 服务返回 HTML，都不会命中。
        """
        if self._cdp_port and time.time() - self._cdp_port_at < 5:
            return self._cdp_port

        candidates = []

        port_file = os.path.join(
            os.environ.get("APPDATA", ""), "Antigravity", "DevToolsActivePort"
        )
        try:
            with open(port_file, "r", encoding="utf-8") as f:
                p = int(f.read().strip().split("\n")[0].strip())
            candidates.append(p)
        except Exception:
            pass

        env_port = os.environ.get("POSTGULL_CDP_PORT", "").strip()
        if env_port.isdigit():
            candidates.append(int(env_port))

        for port in candidates:
            if self._is_cdp(port):
                self._cdp_port, self._cdp_port_at = port, time.time()
                return port

        # 扫 Antigravity 进程实际监听的端口
        for port in self._listening_ports_of_antigravity():
            if port in candidates:
                continue
            if self._is_cdp(port, timeout=0.5):
                self._cdp_port, self._cdp_port_at = port, time.time()
                return port

        self._cdp_port = None
        return None

    @staticmethod
    def _is_cdp(port, timeout=0.8):
        """判断某端口是不是 CDP。真正的 CDP 会返回带 Browser 字段的 JSON。"""
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=timeout
            ) as resp:
                if resp.status != 200:
                    return False
                data = json.loads(resp.read().decode("utf-8", "ignore"))
            return isinstance(data.get("Browser"), str)
        except Exception:
            return False

    @staticmethod
    def _listening_ports_of_antigravity():
        """取 Antigravity 各进程正在监听的本地端口。取不到返回空列表。"""
        try:
            script = (
                "$pids = (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue).Id;"
                "if (-not $pids) { return };"
                "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue"
                " | Where-Object { $pids -contains $_.OwningProcess }"
                " | Select-Object -ExpandProperty LocalPort -Unique"
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=8,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            ports = []
            for line in (out.stdout or "").splitlines():
                s = line.strip()
                if s.isdigit():
                    n = int(s)
                    if 0 < n < 65536:
                        ports.append(n)
            return list(dict.fromkeys(ports))
        except Exception:
            return []

    def probe_agy_foreground(self):
        """直接问 Antigravity 现在哪个对话真的打开着。

        为什么必须现查：registry.json 里的 foreground 是手工登记时的静态快照，
        没有任何进程会去更新它。面板如果只读注册表，就会永远显示登记那一刻的
        状态（work 一直"前台"、bridge 一直"休眠"），人切了窗口也看不出来。
        CDP 的 /json/list 才是实时真相，代价是一次本地 HTTP，2.5 秒一次可以接受。
        """
        port = self.find_cdp_port()
        if port is None:
            return None  # None 表示查不到，此时退回注册表旧值而不是误判成"全休眠"
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as resp:
                pages = json.loads(resp.read().decode("utf-8", "ignore"))
            ids = set()
            for p in pages:
                if p.get("type") == "page" and "/c/" in (p.get("url") or ""):
                    m = re.search(r"/c/([0-9a-fA-F-]{36})", p["url"])
                    if m:
                        ids.add(m.group(1).lower())
            return ids
        except Exception:
            return None

    def poll_data(self):
        reg_data = None
        try:
            if os.path.exists(REG_PATH):
                with open(REG_PATH, "r", encoding="utf-8") as f:
                    reg_data = json.load(f)
                # 用 CDP 实测覆盖注册表里的 foreground，避免显示陈旧快照。
                live = self.probe_agy_foreground()
                if live is not None:
                    for s in reg_data.get("sessions", []):
                        if s.get("software") == "agy" and s.get("id"):
                            s["foreground"] = s["id"].lower() in live
                self.update_sessions(reg_data)

                ext_sleep = reg_data.get("humanSleeping", False)
                if ext_sleep != self.is_human_sleeping:
                    self.switch_sleep.set_state(ext_sleep, trigger_callback=False)
                    self.is_human_sleeping = ext_sleep
                    if ext_sleep:
                        self.lbl_sleep_text.config(text="🌙 休眠中", fg=self.c_yellow)
                        self.banner_sleeping.pack(fill="x", pady=(0, 8), before=self.session_cards[0]["card"])
                    else:
                        self.lbl_sleep_text.config(text="人类在线", fg=self.c_fg)
                        self.banner_sleeping.pack_forget()
        except Exception:
            pass
            
        try:
            self.scan_queue()
        except Exception:
            pass

        # 核心功能：非休眠状态且有积压消息时，自动由 PostGull 启动 receive/flush
        try:
            if reg_data:
                self.check_auto_receive(reg_data)
        except Exception:
            pass
            
        self.after(2500, self.poll_data)

    def check_auto_receive(self, reg_data):
        """自动派发检查：
        如果某个对话当前不处于休眠状态，并且有以他作为收件人的消息积压，
        则自动由 PostGull 启动 receive/flush 将消息投递到该对话。
        """
        if not reg_data:
            return
            
        sessions = reg_data.get("sessions", [])
        quota = reg_data.get("quota", {})
        active_list = [s for s in sessions if s.get("active")]
        
        now = datetime.now().timestamp()
        
        # 统计各分类积压 pending 消息数
        pending_by_target = {}
        for it in self.all_queue_items:
            norm_to = normalize_name(it.get("to", ""))
            pending_by_target[norm_to] = pending_by_target.get(norm_to, 0) + 1

        for s in active_list:
            sw = s.get("software", "").lower()
            cat = s.get("category", "").lower()
            key = f"{sw}-{cat}"
            norm_target = f"{sw}({cat})"
            
            # 1. 检查是否有发往该目标的待办积压
            count = pending_by_target.get(norm_target, 0)
            if count <= 0:
                continue
                
            # 2. 检查该节点当前是否处于休眠状态
            is_sleeping = False
            if sw == "agy":
                # agy 必须前台窗口打开着才算非休眠
                if s.get("foreground") is not True:
                    is_sleeping = True
            elif sw == "codex":
                q = quota.get("codex", {})
                if q.get("available") is False:
                    until_str = q.get("exhaustedUntil")
                    if until_str:
                        try:
                            until_dt = datetime.fromisoformat(until_str.replace("Z", "+00:00"))
                            if datetime.now(until_dt.tzinfo) < until_dt:
                                is_sleeping = True
                        except Exception:
                            is_sleeping = True
                    else:
                        is_sleeping = True
            elif sw == "dsh":
                q = quota.get("dsh", {})
                if q.get("available") is False:
                    is_sleeping = True
                    
            if is_sleeping:
                continue
                
            # 3. 目标处于非休眠状态且有积压消息，检查防抖与是否已有进行中的 flush 进程
            if key in self._flushing_targets:
                continue
                
            last_t = self._last_flush_time.get(key, 0)
            if now - last_t < 10:  # 至少 10 秒冷却
                continue
                
            # 4. 标记正在执行，启动后台线程
            self._flushing_targets.add(key)
            self._last_flush_time[key] = now
            
            threading.Thread(
                target=self._run_auto_flush_task,
                args=(sw, cat, key, norm_target, count),
                daemon=True
            ).start()

    def _run_auto_flush_task(self, sw, cat, key, norm_target, count):
        print(f"[PostGull 自动接收] 触发自动派发: {norm_target} 处于唤醒状态，正在投递 {count} 条积压消息...")
        self.after(0, lambda: self.lbl_footer.config(
            text=f"⚡ 自动接收: 检测到 {norm_target} 唤醒，正在投递 {count} 条积压消息...",
            fg=self.c_blue
        ))
        
        cmd = [POSTGULL_EXE, "flush", sw, "--category", cat]
        # 三种结果要分开报，不能一律当成功：
        #   0 = 真的投出去了（或信箱本来就空）
        #   3 = 对方没开，消息还留在信箱，属正常等待，不是错误
        #   其他 = 投递失败
        # 之前只看 returncode == 0，把「对方没开」也显示成投递成功，
        # 掩盖了自动投递投不出去的真实原因。
        outcome = "failed"
        out_msg = ""
        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=120,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            out_msg = ((res.stdout or "") + (res.stderr or "")).strip()
            if res.returncode == 0:
                outcome = "sent"
            elif res.returncode == 3:
                outcome = "sleeping"
            print(f"[PostGull 自动接收结果] {norm_target} exit={res.returncode} outcome={outcome}\n{out_msg}")
        except Exception as e:
            out_msg = str(e)
            print(f"[PostGull 自动接收异常] {norm_target}: {e}")
        finally:
            self.after(0, lambda: self._on_auto_flush_finished(key, norm_target, outcome, out_msg))

    def _on_auto_flush_finished(self, key, norm_target, outcome, out_msg):
        self._flushing_targets.discard(key)
        self.scan_queue()
        if outcome == "sent":
            self.copy_text("", f"⚡ 自动投递成功：{norm_target} 积压消息已接收！")
            self.lbl_footer.config(
                text=f"✓ 自动投递成功: {norm_target} 积压消息已接收 | 自动派发机制就绪",
                fg=self.c_green
            )
        elif outcome == "sleeping":
            # 对方没开窗口或没带调试端口。消息还在信箱，不是投递失败，
            # 但必须让人看见「为什么没投出去」，否则会以为自动投递坏了。
            first_line = out_msg.splitlines()[0] if out_msg else "目标未激活"
            self.lbl_footer.config(
                text=f"⏸ 未投递: {norm_target} {first_line} | 消息仍在信箱",
                fg="#d29922"
            )
        else:
            first_line = out_msg.splitlines()[0] if out_msg else "未知原因"
            self.lbl_footer.config(
                text=f"✗ 自动投递失败: {norm_target} {first_line}",
                fg=self.c_red
            )

    def update_sessions(self, data):
        sessions = data.get("sessions", [])
        quota = data.get("quota", {})
        active_list = [s for s in sessions if s.get("active")]
        
        # 指纹必须包含所有会影响渲染的字段。之前只算 running，不含 foreground，
        # 结果人切了窗口、foreground 变了，指纹没变就直接 return，卡片永远不重画。
        fp = json.dumps([
            (s.get("id"), s.get("software"), s.get("category"), s.get("running"), s.get("foreground"))
            for s in active_list
        ]) + str(quota)
        if fp == self._last_sessions_fingerprint:
            return
        self._last_sessions_fingerprint = fp

        for i, card_obj in enumerate(self.session_cards):
            if i < len(active_list):
                s = active_list[i]
                sw = s.get("software", "").lower()
                cat = s.get("category", "").lower()
                key = f"{sw}-{cat}"
                sid = s.get("id", "none") or "none"
                short_id = sid[:12] + "..." if len(sid) > 12 else sid
                
                color = self.c_green
                status_text = ""
                if s.get("software") == "codex" and quota.get("codex", {}).get("available") is False:
                    color = self.c_yellow
                    status_text = " (休眠中)"

                # active 只表示「该类别登记了这个会话」，不代表窗口开着。
                # Antigravity 的 foreground 才是真实前台状态：只有 foreground=true 的那个
                # 对话在界面里打开着，其余登记过的会话虽然 active，但收不到消息（只能进信箱）。
                # 未打开时用和 codex 休眠完全一样的显示：橘红色圆点 + (休眠中)。
                if sw == "agy" and s.get("foreground") is not True:
                    color = self.c_yellow
                    status_text = " (休眠中)"
                
                card_obj["dot"].config(fg=color)
                card_obj["name"].config(text=f"{sw}({cat}){status_text}", fg=self.c_fg)
                card_obj["btn_id"].config(
                    text=f"ID: {short_id}",
                    command=lambda id_val=sid: self.copy_text(id_val, f"✓ 会话 ID [{id_val[:8]}...] 已成功复制！")
                )
                prompt_txt = PROMPTS.get(key, "")
                card_obj["btn_new"].config(
                    command=lambda p=prompt_txt: self.copy_text(p, "✓ 新对话替换提示词已成功复制！")
                )
                card_obj["card"].pack(fill="x", pady=5)
            else:
                card_obj["card"].pack_forget()

    def scan_queue(self):
        items = []
        counts = {"全部": 0}
        for f in self.filter_rows.keys():
            counts[f] = 0

        if os.path.exists(QUEUE_DIR):
            for file_path in glob.glob(os.path.join(QUEUE_DIR, "*.jsonl")):
                if os.path.basename(file_path) == "archive.jsonl":
                    continue
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        for line in f:
                            l = line.strip()
                            if not l: continue
                            try:
                                d = json.loads(l)
                                if d.get("status") == "pending":
                                    d["_file_path"] = file_path
                                    items.append(d)
                                    norm_to = normalize_name(d.get("to", ""))
                                    counts["全部"] += 1
                                    if norm_to in counts:
                                        counts[norm_to] += 1
                            except Exception:
                                pass
                except Exception:
                    pass

        self.all_queue_items = items
        self.btn_tab2.config(text=f"信箱暂存区 ({len(items)})")
        
        for f, obj in self.filter_rows.items():
            c = counts.get(f, 0)
            if c > 0:
                obj["badge"].config(text=f"({c}) ")
            else:
                obj["badge"].config(text="")
                
        self.render_queue_items(force=False)

    def render_queue_items(self, force=False):
        fp = self.current_filter + "|" + json.dumps([it.get("id") for it in self.all_queue_items])
        if not force and fp == self._last_rendered_fingerprint:
            return
        self._last_rendered_fingerprint = fp

        for widget in self.q_scrollable_frame.winfo_children():
            widget.destroy()
            
        filtered = []
        for it in self.all_queue_items:
            norm_to = normalize_name(it.get("to", ""))
            if self.current_filter == "全部" or norm_to == self.current_filter:
                filtered.append(it)
                
        if not filtered:
            msg = "✅ 当前筛选分类下无排队暂存消息" if self.current_filter != "全部" else "✅ 信箱已清空，所有节点暂存队列畅通"
            lbl_empty = tk.Label(self.q_scrollable_frame, text=msg, font=(FONT_FAMILY, 11), bg=self.c_card, fg="#484f58", pady=40)
            lbl_empty.pack(fill="x")
            return

        for item in filtered:
            f_from = normalize_name(item.get("from", "未知"))
            f_to = normalize_name(item.get("to", "未知"))
            f_time = item.get("createdAt", "")
            try:
                dt = datetime.fromisoformat(f_time.replace("Z", "+00:00"))
                time_str = dt.astimezone().strftime("%m-%d %H:%M:%S")
            except Exception:
                time_str = f_time[:19].replace("T", " ")
                
            summary = item.get("summary", "(无摘要)")
            reason = item.get("sleepReason", "")
            
            box = tk.Frame(self.q_scrollable_frame, bg="#0d1117", highlightbackground=self.c_border, highlightthickness=1, padx=14, pady=10)
            box.pack(fill="x", pady=6)
            
            # 第一行：路由 + 详情按钮 + 时间
            h_row = tk.Frame(box, bg="#0d1117")
            h_row.pack(fill="x")
            
            route_lbl = tk.Label(h_row, text=f"{f_from}  ➔  {f_to}", font=(FONT_FAMILY, 11, "bold"), bg="#0d1117", fg=self.c_blue)
            route_lbl.pack(side="left")
            
            # 详情与处置按钮
            btn_detail = tk.Button(
                h_row, text="🔍 详情与处置", font=(FONT_FAMILY, 9, "bold"),
                bg=self.c_btn, fg=self.c_fg, activebackground=self.c_blue, activeforeground="#ffffff",
                relief="flat", highlightbackground=self.c_border, highlightthickness=1,
                padx=8, pady=1, cursor="hand2",
                command=lambda it=item: self.open_detail_dialog(it)
            )
            btn_detail.pack(side="left", padx=(14, 0))
            
            time_lbl = tk.Label(h_row, text=time_str, font=(FONT_FAMILY, 10), bg="#0d1117", fg=self.c_dim)
            time_lbl.pack(side="right")
            
            # 休眠暂存原因
            if reason:
                r_lbl = tk.Label(box, text=f"⏸️ 暂存原因: {reason}", font=(FONT_FAMILY, 10), bg="#0d1117", fg=self.c_yellow, anchor="w")
                r_lbl.pack(fill="x", pady=(3, 0))
                
            # 摘要
            s_lbl = tk.Label(box, text=summary, font=(FONT_FAMILY, 10), bg="#0d1117", fg=self.c_fg, justify="left", wraplength=620, anchor="w")
            s_lbl.pack(fill="x", pady=(4, 0))

if __name__ == "__main__":
    app = BridgeMonitorApp()
    app.mainloop()
