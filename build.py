"""
CikaChat - PyInstaller 打包脚本
运行: python build.py
"""
import os
import sys
import subprocess


def build():
    """使用 PyInstaller 打包为独立 exe"""
    base_dir = os.path.dirname(os.path.abspath(__file__))

    # 静态资源文件（Windows 用分号分隔）
    sep = ';' if sys.platform == 'win32' else ':'
    add_data = [
        f'desktop.html{sep}.',
        f'opensource.html{sep}.',
        f'css{sep}css',
        f'js{sep}js',
    ]

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--name=CikaChat',
        '--onefile',
        '--windowed',
        '--clean',
        '--noconfirm',
        f'--icon=NONE',
    ]

    for data in add_data:
        cmd.extend(['--add-data', data])

    cmd.append(os.path.join(base_dir, 'main.py'))

    print(f'[BUILD] {" ".join(cmd)}')
    subprocess.run(cmd, cwd=base_dir, check=True)

    print('\n[DONE] 打包完成！exe 位于 dist/CikaChat.exe')


if __name__ == '__main__':
    build()
