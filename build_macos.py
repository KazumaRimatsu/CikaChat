#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat Tauri macOS 构建脚本

用法:
    python3 build_macos.py -o <输出目录>
    python3 build_macos.py                 # 默认输出到 ./dist
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import time
from pathlib import Path


def fmt_size(num):
    """将字节数格式化为人类可读的大小"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024:
            return f"{num:.2f} {unit}"
        num /= 1024
    return f"{num:.2f} PB"


def main():
    script_dir = Path(__file__).resolve().parent

    if platform.system() != "Darwin":
        print(f"警告: 当前系统为 {platform.system()}，此脚本仅适用于 macOS。")

    # 解析参数
    parser = argparse.ArgumentParser(description="KnockChat Tauri macOS 构建脚本")
    parser.add_argument(
        "-o", "--output-dir",
        default=str(script_dir / "dist"),
        help="输出目录（默认: ./dist）",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir)

    # 读取产品名称
    config_path = script_dir / "src-tauri" / "tauri.conf.json"
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    product_name = config.get("productName", "KnockChat")

    print("=" * 30)
    print("  KnockChat Tauri Build Script")
    print("=" * 30)
    print(f"产品名称: {product_name}")
    print(f"输出目录: {output_dir}")
    print("=" * 30)

    # 确保输出目录存在
    if not output_dir.exists():
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"已创建输出目录: {output_dir}")

    # 时间戳命名的构建产物目录
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    build_dir = output_dir / timestamp

    print("\n开始构建...")

    # 设置 TAURI_OUTPUT_DIR 环境变量并执行构建
    env = os.environ.copy()
    env["TAURI_OUTPUT_DIR"] = str(output_dir)

    try:
        result = subprocess.run(
            ["npm", "run", "tauri", "build"],
            cwd=str(script_dir),
            env=env,
        )
        if result.returncode != 0:
            raise SystemExit(f"Tauri 构建失败，退出码: {result.returncode}")
        print("\n构建完成!")
    finally:
        env.pop("TAURI_OUTPUT_DIR", None)

    # 收集构建产物到时间戳目录
    build_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = script_dir / "src-tauri" / "target" / "release" / "bundle"

    if bundle_dir.exists():
        # .app 应用包（macOS 目录型应用）
        macos_dir = bundle_dir / "macos"
        if macos_dir.exists():
            for app in macos_dir.glob("*.app"):
                shutil.copytree(app, build_dir / app.name)
                print(f"已复制应用包: {app.name}")

        # dmg 安装镜像
        dmg_dir = bundle_dir / "dmg"
        if dmg_dir.exists():
            for dmg in dmg_dir.glob("*.dmg"):
                shutil.copy2(dmg, build_dir / dmg.name)
                print(f"已复制安装镜像: {dmg.name}")

        # release 目录下的可执行文件
        release_dir = script_dir / "src-tauri" / "target" / "release"
        binary = release_dir / product_name
        if binary.exists() and binary.is_file():
            shutil.copy2(binary, build_dir / binary.name)
            print(f"已复制可执行文件: {binary.name}")

        print(f"构建产物已复制到: {build_dir}")
    else:
        # TAURI_OUTPUT_DIR 生效时产物已直接输出到目录
        print(f"构建产物已输出到目录: {output_dir}")

    # 显示产物列表
    print("\n产物列表:")
    found = False
    if build_dir.exists():
        for item in build_dir.rglob("*"):
            if item.suffix == ".dmg" and item.is_file():
                print(f"  {item} ({fmt_size(item.stat().st_size)})")
                found = True
            elif item.suffix == ".app" and item.is_dir():
                print(f"  {item} (目录)")
                found = True
    if not found:
        # 兼容 TAURI_OUTPUT_DIR 直接输出到输出目录的情况
        for item in output_dir.rglob("*"):
            if item.suffix == ".dmg" and item.is_file():
                print(f"  {item} ({fmt_size(item.stat().st_size)})")
            elif item.suffix == ".app" and item.is_dir():
                print(f"  {item} (目录)")

    print("\n完成!")

    # 清理编译缓存
    target_dir = script_dir / "src-tauri" / "target"
    if target_dir.exists():
        print("\n清理编译缓存...")
        shutil.rmtree(target_dir, ignore_errors=True)
        print(f"编译缓存已清理: {target_dir}")


if __name__ == "__main__":
    main()
