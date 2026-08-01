"""
CikaChat - PyWebView Desktop Wrapper
"""
import os
import sys
import ctypes
import subprocess
import webview

HTTP_PORT = 43999
APP_NAME = 'CikaChat'


def get_exe_dir():
    """获取 exe 所在目录（兼容 PyInstaller 打包和开发环境）"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def get_base_path():
    """获取资源文件基础路径（兼容 PyInstaller 打包和开发环境）"""
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def kill_webview2_processes():
    """杀掉所有残留的 WebView2 子进程（仅在确认原实例已死时调用）"""
    try:
        subprocess.run(
            ['taskkill', '/F', '/IM', 'msedgewebview2.exe'],
            capture_output=True,
        )
    except Exception:
        pass


def check_single_instance(data_dir: str) -> bool:
    """单实例检测，防止 WebView2 数据目录被多进程同时占用"""
    lock_file = os.path.join(data_dir, '.lock')

    if os.path.exists(lock_file):
        try:
            with open(lock_file, 'r') as f:
                old_pid = int(f.read().strip())
            handle = ctypes.windll.kernel32.OpenProcess(0x0400, False, old_pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return False  # 旧进程仍在运行
            # 旧进程已死，清理残留的 WebView2 子进程
            kill_webview2_processes()
        except (ValueError, OSError):
            pass

    with open(lock_file, 'w') as f:
        f.write(str(os.getpid()))
    return True


def cleanup_lock(data_dir: str):
    """退出时清理锁文件"""
    lock_file = os.path.join(data_dir, '.lock')
    try:
        os.remove(lock_file)
    except OSError:
        pass


def main():
    exe_dir = get_exe_dir()
    base_path = get_base_path()

    if not check_single_instance(exe_dir):
        ctypes.windll.user32.MessageBoxW(0, 'CikaChat 已在运行中', APP_NAME, 0x30)
        return

    # WebView2 用户数据持久化目录（放在 exe 同目录下）
    webview_dir = os.path.join(exe_dir, 'userdata')
    os.makedirs(webview_dir, exist_ok=True)
    os.environ['WEBVIEW2_USER_DATA_FOLDER'] = webview_dir

    html_path = os.path.join(base_path, 'desktop.html')

    window = webview.create_window(
        title=APP_NAME,
        url=html_path,
        width=1200,
        height=800,
        min_size=(800, 600),
        resizable=True,
        text_select=True,
        confirm_close=True,
    )

    # HTTP 服务器 + 固定端口，保证 origin 一致，localStorage 持久化
    for attempt in range(2):
        try:
            webview.start(
                debug=False,
                http_server=True,
                http_port=HTTP_PORT,
            )
            break
        except Exception:
            if attempt == 0:
                kill_webview2_processes()
            else:
                raise

    cleanup_lock(exe_dir)


if __name__ == '__main__':
    main()
