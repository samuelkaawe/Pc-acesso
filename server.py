# -*- coding: utf-8 -*-
"""RemotePC Server - controle do PC pelo celular.
Rode:  python server.py   (ou use o RemotePC-Server.exe gerado pelo GitHub Actions)
"""
import os, sys, io, json, time, hmac, string, shutil, socket, secrets, asyncio, argparse
import platform, threading, subprocess, traceback, webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

if os.name == "nt":  # coordenadas em pixels reais (antes de importar mss/pynput)
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

from aiohttp import web
import mss
from PIL import Image, ImageOps
from pynput.mouse import Controller as MouseController, Button
from pynput.keyboard import Controller as KeyController, Key

try:
    import numpy as np
except Exception:
    np = None
try:
    import pyvirtualcam
    HAVE_VCAM = np is not None
except Exception:
    HAVE_VCAM = False
try:
    import vgamepad as vg
    HAVE_VG = True
except Exception:
    HAVE_VG = False
try:
    import psutil
except Exception:
    psutil = None
try:
    from send2trash import send2trash
except Exception:
    send2trash = None

FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent
WEB_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR)) / "web"
CONFIG_PATH = APP_DIR / "config.json"

DEFAULT_SHORTCUTS = [
    {"id": "copy", "label": "Copiar", "icon": "📋", "type": "hotkey", "value": "ctrl+c"},
    {"id": "paste", "label": "Colar", "icon": "📥", "type": "hotkey", "value": "ctrl+v"},
    {"id": "undo", "label": "Desfazer", "icon": "↩️", "type": "hotkey", "value": "ctrl+z"},
    {"id": "alttab", "label": "Alternar janela", "icon": "🪟", "type": "hotkey", "value": "alt+tab"},
    {"id": "desktop", "label": "Área de trabalho", "icon": "🖥️", "type": "hotkey", "value": "win+d"},
    {"id": "taskmgr", "label": "Gerenciador de tarefas", "icon": "📊", "type": "hotkey", "value": "ctrl+shift+esc"},
    {"id": "snip", "label": "Captura de tela", "icon": "📸", "type": "hotkey", "value": "win+shift+s"},
    {"id": "play", "label": "Play/Pause", "icon": "⏯️", "type": "media", "value": "playpause"},
    {"id": "volup", "label": "Volume +", "icon": "🔊", "type": "media", "value": "volup"},
    {"id": "voldn", "label": "Volume −", "icon": "🔉", "type": "media", "value": "voldown"},
    {"id": "mute", "label": "Mudo", "icon": "🔇", "type": "media", "value": "mute"},
    {"id": "lock", "label": "Bloquear PC", "icon": "🔒", "type": "power", "value": "lock"},
    {"id": "calc", "label": "Calculadora", "icon": "🧮", "type": "open", "value": "calc.exe"},
    {"id": "notepad", "label": "Bloco de notas", "icon": "📝", "type": "open", "value": "notepad.exe"},
    {"id": "web", "label": "Google", "icon": "🌐", "type": "url", "value": "https://www.google.com"},
]

CFG = {}
MONS = []
mouse = MouseController()
kb = KeyController()
BUTTONS = {"left": Button.left, "right": Button.right, "middle": Button.middle}

SPECIAL = {
    "ctrl": Key.ctrl, "alt": Key.alt, "shift": Key.shift, "win": Key.cmd, "cmd": Key.cmd,
    "enter": Key.enter, "esc": Key.esc, "tab": Key.tab, "space": Key.space,
    "backspace": Key.backspace, "delete": Key.delete, "del": Key.delete,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "home": Key.home, "end": Key.end, "pageup": Key.page_up, "pagedown": Key.page_down,
    "insert": Key.insert, "printscreen": Key.print_screen, "capslock": Key.caps_lock, "menu": Key.menu,
    "playpause": Key.media_play_pause, "next": Key.media_next, "prev": Key.media_previous,
    "volup": Key.media_volume_up, "voldown": Key.media_volume_down, "mute": Key.media_volume_mute,
}
for _i in range(1, 21):
    SPECIAL["f%d" % _i] = getattr(Key, "f%d" % _i)


def resolve_key(name):
    n = str(name).lower()
    if n in SPECIAL:
        return SPECIAL[n]
    if len(str(name)) == 1:
        return str(name)
    return None


def press_combo(keys):
    ks = [k for k in (resolve_key(k) for k in keys) if k is not None]
    for k in ks:
        kb.press(k)
    for k in reversed(ks):
        kb.release(k)


def tap_key(name):
    k = resolve_key(name)
    if k is not None:
        kb.press(k)
        kb.release(k)


def popen_hidden(cmd):
    flags = 0x08000000 if os.name == "nt" else 0
    subprocess.Popen(cmd, shell=True, creationflags=flags)


def open_path(p):
    if os.name == "nt":
        os.startfile(p)  # noqa
    else:
        subprocess.Popen(["xdg-open", p])


def power_action(a):
    if os.name != "nt":
        return "Disponível só no Windows"
    cmds = {
        "lock": "rundll32.exe user32.dll,LockWorkStation",
        "sleep": "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
        "shutdown": "shutdown /s /t 30",
        "restart": "shutdown /r /t 30",
        "cancel": "shutdown /a",
    }
    if a in cmds:
        popen_hidden(cmds[a])


def run_shortcut(sc):
    t, v = sc.get("type"), str(sc.get("value", ""))
    if t == "hotkey":
        press_combo([k.strip() for k in v.split("+") if k.strip()])
    elif t == "text":
        kb.type(v)
    elif t == "open":
        open_path(v)
    elif t == "url":
        webbrowser.open(v)
    elif t == "cmd":
        popen_hidden(v)
    elif t == "media":
        tap_key(v)
    elif t == "power":
        return power_action(v)


# ---------------- gamepad virtual (ViGEmBus) ----------------
PAD = None
PAD_ERR = 0
GP_BTN = {}
if HAVE_VG:
    _B = vg.XUSB_BUTTON
    GP_BTN = {
        "a": _B.XUSB_GAMEPAD_A, "b": _B.XUSB_GAMEPAD_B, "x": _B.XUSB_GAMEPAD_X, "y": _B.XUSB_GAMEPAD_Y,
        "lb": _B.XUSB_GAMEPAD_LEFT_SHOULDER, "rb": _B.XUSB_GAMEPAD_RIGHT_SHOULDER,
        "start": _B.XUSB_GAMEPAD_START, "back": _B.XUSB_GAMEPAD_BACK,
        "l3": _B.XUSB_GAMEPAD_LEFT_THUMB, "r3": _B.XUSB_GAMEPAD_RIGHT_THUMB,
        "up": _B.XUSB_GAMEPAD_DPAD_UP, "down": _B.XUSB_GAMEPAD_DPAD_DOWN,
        "left": _B.XUSB_GAMEPAD_DPAD_LEFT, "right": _B.XUSB_GAMEPAD_DPAD_RIGHT,
        "guide": _B.XUSB_GAMEPAD_GUIDE,
    }


def get_pad():
    global PAD, PAD_ERR
    if PAD is not None:
        return PAD
    if not HAVE_VG or (PAD_ERR and time.time() - PAD_ERR < 5):
        return None
    try:
        PAD = vg.VX360Gamepad()
        PAD_ERR = 0
    except Exception as e:
        PAD_ERR = time.time()
        print("Gamepad virtual indisponível:", e)
        return None
    return PAD


def clamp(v, a, b):
    return max(a, min(b, v))


def handle(msg, st):
    """Processa uma mensagem de controle. Retorna texto de erro (opcional)."""
    t = msg.get("t")
    if t == "mm":
        mouse.move(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
    elif t == "ma":
        i = st["mon"]
        if 0 <= i < len(MONS):
            m = MONS[i]
            mouse.position = (int(m["left"] + float(msg["x"]) * m["width"]),
                              int(m["top"] + float(msg["y"]) * m["height"]))
    elif t == "mb":
        b = BUTTONS.get(msg.get("b", "left"), Button.left)
        (mouse.press if msg.get("d") else mouse.release)(b)
    elif t == "mc":
        mouse.click(BUTTONS.get(msg.get("b", "left"), Button.left), int(msg.get("n", 1)))
    elif t == "sc":
        mouse.scroll(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
    elif t == "k":
        k = resolve_key(msg.get("k", ""))
        if k is not None:
            (kb.press if msg.get("d", 1) else kb.release)(k)
    elif t == "tap":
        tap_key(msg.get("k", ""))
    elif t == "hk":
        press_combo(msg.get("keys", []))
    elif t == "txt":
        kb.type(str(msg.get("s", "")))
    elif t == "sh":
        for sc in CFG["shortcuts"]:
            if sc.get("id") == msg.get("id"):
                return run_shortcut(sc)
    elif t == "mon":
        st["mon"] = int(msg.get("i", 1))
    elif t == "gpb":
        pad = get_pad()
        if pad is None:
            return "Gamepad virtual indisponível: instale o ViGEmBus no PC."
        b = GP_BTN.get(msg.get("b"))
        if b is not None:
            (pad.press_button if msg.get("d") else pad.release_button)(button=b)
            pad.update()
    elif t == "gps":
        pad = get_pad()
        if pad is None:
            return "Gamepad virtual indisponível: instale o ViGEmBus no PC."
        f = lambda k: float(msg.get(k, 0))
        pad.left_joystick_float(x_value_float=clamp(f("lx"), -1, 1), y_value_float=clamp(f("ly"), -1, 1))
        pad.right_joystick_float(x_value_float=clamp(f("rx"), -1, 1), y_value_float=clamp(f("ry"), -1, 1))
        pad.left_trigger_float(value_float=clamp(f("lt"), 0, 1))
        pad.right_trigger_float(value_float=clamp(f("rt"), 0, 1))
        pad.update()
    return None


# ---------------- autenticação ----------------
FAILS = {}


def check_pin(request):
    pin = request.headers.get("X-Pin") or request.query.get("pin", "")
    if not pin:
        return False
    ip = request.remote or "?"
    now = time.time()
    f = FAILS.get(ip, {"n": 0, "lock": 0})
    if f["lock"] > now:
        return False
    if hmac.compare_digest(str(pin), str(CFG["pin"])):
        FAILS.pop(ip, None)
        return True
    f["n"] += 1
    if f["n"] >= 5:
        f["lock"], f["n"] = now + 60, 0
    FAILS[ip] = f
    return False


@web.middleware
async def auth_mw(request, handler):
    p = request.path
    if (p.startswith("/api/") or p.startswith("/ws")) and not check_pin(request):
        return web.json_response({"error": "pin"}, status=401)
    return await handler(request)


# ---------------- rotas ----------------
async def index(request):
    return web.FileResponse(WEB_DIR / "index.html")


async def api_info(request):
    d = {"host": socket.gethostname(), "os": platform.platform(), "monitors": max(0, len(MONS) - 1),
         "vg": HAVE_VG, "vcam": HAVE_VCAM, "ips": local_ips(), "port": CFG["port"]}
    if psutil:
        d["cpu"] = psutil.cpu_percent()
        d["ram"] = psutil.virtual_memory().percent
    return web.json_response(d)


async def ws_control(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    st, warned = {"mon": 1}, False
    async for m in ws:
        if m.type == web.WSMsgType.TEXT:
            err = None
            try:
                err = handle(json.loads(m.data), st)
            except Exception as e:
                print("erro no comando:", e)
            if err and not warned:
                warned = True
                await ws.send_json({"t": "toast", "msg": err})
        elif m.type == web.WSMsgType.ERROR:
            break
    pad = PAD
    if pad is not None:
        try:
            pad.reset()
            pad.update()
        except Exception:
            pass
    return ws


async def ws_screen(request):
    ws = web.WebSocketResponse(heartbeat=20, compress=False)
    await ws.prepare(request)
    loop = asyncio.get_running_loop()
    q = request.query
    cfg = {"q": clamp(int(q.get("q", 55)), 10, 95), "scale": clamp(float(q.get("scale", 0.6)), 0.2, 1.0),
           "fps": clamp(int(q.get("fps", 20)), 1, 60), "mon": int(q.get("mon", 1))}
    stop = threading.Event()

    def send(coro):
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=5)

    def worker():
        try:
            with mss.mss() as sct:
                MONS[:] = sct.monitors
                last = None
                while not stop.is_set():
                    t0 = time.time()
                    i = clamp(cfg["mon"], 0, len(sct.monitors) - 1)
                    mon = sct.monitors[i]
                    if i != last:
                        last = i
                        send(ws.send_json({"t": "info", "mon": i, "w": mon["width"], "h": mon["height"],
                                           "monitors": len(sct.monitors) - 1}))
                    shot = sct.grab(mon)
                    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
                    sc = cfg["scale"]
                    if sc < 0.999:
                        img = img.resize((max(1, int(img.width * sc)), max(1, int(img.height * sc))), Image.BILINEAR)
                    buf = io.BytesIO()
                    img.save(buf, "JPEG", quality=int(cfg["q"]))
                    send(ws.send_bytes(buf.getvalue()))
                    delay = 1.0 / cfg["fps"] - (time.time() - t0)
                    if delay > 0:
                        stop.wait(delay)
        except Exception as e:
            if not stop.is_set():
                print("stream de tela encerrado:", e)

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    try:
        async for m in ws:
            if m.type == web.WSMsgType.TEXT:
                try:
                    d = json.loads(m.data)
                    if d.get("t") == "cfg":
                        cfg["q"] = clamp(int(d.get("q", cfg["q"])), 10, 95)
                        cfg["scale"] = clamp(float(d.get("scale", cfg["scale"])), 0.2, 1.0)
                        cfg["fps"] = clamp(int(d.get("fps", cfg["fps"])), 1, 60)
                        cfg["mon"] = int(d.get("mon", cfg["mon"]))
                except Exception:
                    pass
            elif m.type == web.WSMsgType.ERROR:
                break
    finally:
        stop.set()
    return ws


class VCam:
    def __init__(self, w, h, mirror):
        self.w, self.h, self.mirror, self.cam, self.err = w, h, mirror, None, None

    def push(self, data):
        img = Image.open(io.BytesIO(data)).convert("RGB")
        if self.mirror:
            img = ImageOps.mirror(img)
        img = ImageOps.pad(img, (self.w, self.h), color=(0, 0, 0))
        if self.cam is None:
            self.cam = pyvirtualcam.Camera(width=self.w, height=self.h, fps=30, fmt=pyvirtualcam.PixelFormat.RGB)
        self.cam.send(np.array(img, dtype=np.uint8))

    def close(self):
        try:
            if self.cam:
                self.cam.close()
        except Exception:
            pass
        self.cam = None


CAM_ACTIVE = None


async def ws_cam(request):
    global CAM_ACTIVE
    ws = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024, heartbeat=20)
    await ws.prepare(request)
    if not HAVE_VCAM:
        await ws.send_str("pyvirtualcam/numpy não disponível no servidor")
        await ws.close()
        return ws
    vc = VCam(CFG["cam_width"], CFG["cam_height"], CFG.get("cam_mirror", False))
    if CAM_ACTIVE:
        CAM_ACTIVE.close()
    CAM_ACTIVE = vc
    loop = asyncio.get_running_loop()
    ex = ThreadPoolExecutor(max_workers=1)
    state = {"busy": False}

    def done(f):
        state["busy"] = False
        try:
            e = f.exception()
            if e and not vc.err:
                vc.err = str(e)
        except Exception:
            pass

    async for m in ws:
        if m.type == web.WSMsgType.BINARY:
            if vc.err:
                await ws.send_str("Erro da câmera virtual: %s (instale o OBS Studio)" % vc.err)
                break
            if state["busy"]:
                continue
            state["busy"] = True
            loop.run_in_executor(ex, vc.push, m.data).add_done_callback(done)
        elif m.type == web.WSMsgType.ERROR:
            break
    ex.shutdown(wait=False)
    vc.close()
    return ws


def list_roots():
    if os.name == "nt":
        return [{"name": "%s:\\" % d, "dir": True, "size": 0, "mtime": 0}
                for d in string.ascii_uppercase if os.path.exists("%s:\\" % d)]
    return [{"name": "/", "dir": True, "size": 0, "mtime": 0}]


async def api_fs_list(request):
    p = request.query.get("path", "")
    if not p:
        return web.json_response({"path": "", "parent": None, "items": list_roots()})
    path = Path(p)
    if not path.is_dir():
        return web.json_response({"error": "Pasta não encontrada"})
    items = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    isdir = e.is_dir()
                    s = e.stat()
                except OSError:
                    continue
                items.append({"name": e.name, "dir": isdir, "size": 0 if isdir else s.st_size, "mtime": int(s.st_mtime)})
    except PermissionError:
        return web.json_response({"error": "Sem permissão"})
    items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
    parent = str(path.parent) if path.parent != path else ""
    return web.json_response({"path": str(path), "parent": parent, "items": items})


async def api_fs_download(request):
    path = Path(request.query.get("path", ""))
    if not path.is_file():
        return web.json_response({"error": "Arquivo não encontrado"}, status=404)
    ascii_name = path.name.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
    cd = 'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(path.name))
    return web.FileResponse(path, headers={"Content-Disposition": cd})


async def api_fs_upload(request):
    dest = Path(request.query.get("path", ""))
    if not dest.is_dir():
        return web.json_response({"error": "Pasta de destino inválida"})
    reader = await request.multipart()
    saved = []
    while True:
        part = await reader.next()
        if part is None:
            break
        if not part.filename:
            continue
        name = os.path.basename(part.filename)
        target, n = dest / name, 1
        while target.exists():
            target = dest / ("%s (%d)%s" % (Path(name).stem, n, Path(name).suffix))
            n += 1
        with open(target, "wb") as f:
            while True:
                chunk = await part.read_chunk(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        saved.append(target.name)
    return web.json_response({"saved": saved})


async def api_fs_op(request):
    d = await request.json()
    op, p = d.get("op"), Path(d.get("path", ""))
    try:
        if op == "mkdir":
            p.mkdir(parents=True, exist_ok=False)
        elif op == "rename":
            p.rename(p.with_name(os.path.basename(d["new"])))
        elif op == "delete":
            if send2trash:
                send2trash(str(p))
            elif p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
        elif op == "open":
            open_path(str(p))
        else:
            return web.json_response({"error": "Operação inválida"})
    except Exception as e:
        return web.json_response({"error": str(e)})
    return web.json_response({"ok": True})


async def api_shortcuts_get(request):
    return web.json_response(CFG["shortcuts"])


async def api_shortcuts_set(request):
    data = await request.json()
    out = []
    for s in data if isinstance(data, list) else []:
        if isinstance(s, dict) and s.get("id") and s.get("type"):
            out.append({k: str(s.get(k, "")) for k in ("id", "label", "icon", "type", "value")})
    CFG["shortcuts"] = out
    save_config()
    return web.json_response({"ok": True})


async def api_power(request):
    d = await request.json()
    return web.json_response({"error": power_action(d.get("a", ""))})


def local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def save_config():
    try:
        CONFIG_PATH.write_text(json.dumps(CFG, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print("Não consegui salvar config.json:", e)


def load_config(args):
    cfg = {"pin": None, "port": 8765, "cam_width": 1280, "cam_height": 720, "cam_mirror": False,
           "shortcuts": DEFAULT_SHORTCUTS}
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    if args.pin:
        cfg["pin"] = args.pin
    if args.port:
        cfg["port"] = args.port
    if not cfg.get("pin"):
        cfg["pin"] = "%06d" % secrets.randbelow(1000000)
    CFG.update(cfg)
    save_config()


async def no_cache(request, response):
    response.headers["Cache-Control"] = "no-store"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int)
    ap.add_argument("--pin")
    args = ap.parse_args()
    load_config(args)
    try:
        with mss.mss() as sct:
            MONS[:] = sct.monitors
    except Exception as e:
        print("Aviso: não consegui ler os monitores:", e)

    app = web.Application(middlewares=[auth_mw], client_max_size=64 * 1024 * 1024)
    app.on_response_prepare.append(no_cache)
    app.router.add_get("/", index)
    app.router.add_static("/static", WEB_DIR)
    app.router.add_get("/api/info", api_info)
    app.router.add_get("/ws", ws_control)
    app.router.add_get("/ws/screen", ws_screen)
    app.router.add_get("/ws/cam", ws_cam)
    app.router.add_get("/api/fs/list", api_fs_list)
    app.router.add_get("/api/fs/download", api_fs_download)
    app.router.add_post("/api/fs/upload", api_fs_upload)
    app.router.add_post("/api/fs/op", api_fs_op)
    app.router.add_get("/api/shortcuts", api_shortcuts_get)
    app.router.add_post("/api/shortcuts", api_shortcuts_set)
    app.router.add_post("/api/power", api_power)

    port = CFG["port"]
    print("=" * 50)
    print(" RemotePC Server")
    print(" PIN: %s" % CFG["pin"])
    for ip in local_ips():
        print(" No celular, conecte em:  %s:%d" % (ip, port))
    print(" Gamepad virtual (ViGEmBus): %s" % ("ok" if HAVE_VG else "não instalado"))
    print(" Webcam virtual (OBS):       %s" % ("ok" if HAVE_VCAM else "não instalado"))
    print("=" * 50)
    web.run_app(app, host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        input("\nErro. Pressione Enter para fechar...")
