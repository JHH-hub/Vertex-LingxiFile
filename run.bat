@echo off
chcp 936 >nul
title 灵犀文件管家 - LingXi File Manager
color 0A
echo.
echo ========================================
echo   灵犀文件管家 v1.0
echo   LingXi File Manager
echo ========================================
echo.

rem 检查Python是否安装
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Python，请先安装Python 3.8+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

rem 检查依赖是否安装
echo [检查] 正在检查依赖包...
python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo [安装] 正在安装依赖包...
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo [完成] 依赖安装成功
) else (
    echo [检查] 依赖已安装
)

echo.
echo [启动] 正在启动灵犀文件管家...
echo 访问地址: http://127.0.0.1:7870
echo 按 Ctrl+C 停止服务
echo.

rem 启动服务
python server.py

if errorlevel 1 (
    echo.
    echo [错误] 服务启动失败，请检查端口7870是否被占用
    echo 可以修改 server.py 中的端口号重新尝试
    pause
)

pause
