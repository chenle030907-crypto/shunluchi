@echo off
chcp 65001 >nul
cd /d "D:\codex\shunluchi-main"

git config --global --add safe.directory D:/codex/shunluchi-main
git config --global user.name "chenle030907-crypto"
git config --global user.email "chenle030907@gmail.com"

if not exist ".git" (
    echo Init git...
    git init
)

echo Set remote...
git remote remove origin 2>nul
git remote add origin https://github.com/chenle030907-crypto/shunluchi.git

git branch -M main
git add .
git commit -m "feat: Amap route planning API + Haversine distance estimation"
git push -u origin main --force
pause
