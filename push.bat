@echo off
chcp 65001 >nul
cd /d "D:\codex\shunluchi-main"

echo Fixing git ownership...
git config --global --add safe.directory D:/codex/shunluchi-main

echo Setting git identity...
git config --global user.name "chenle030907-crypto"
git config --global user.email "chenle030907@gmail.com"

if not exist ".git" (
    echo Initializing git repo...
    git init
    git remote add origin https://github.com/chenle030907-crypto/shunluchi.git
)

git add .
git commit -m "feat: Amap route planning API + Haversine distance estimation"
git push -u origin main --force
pause
