@echo off
chcp 65001 >nul
title Pocket Beacon
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
pause
