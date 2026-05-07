@echo off
chcp 65001 >nul
cd /d "D:\codex\shunluchi-main"
git config --global --add safe.directory D:/codex/shunluchi-main
git config --global user.name "chenle030907-crypto"
git config --global user.email "chenle030907@gmail.com"
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/chenle030907-crypto/shunluchi.git
git add .
git commit -m "feat: hand-drawn theme + dark mode + skeleton loading + mobile polish"
git push -u origin main --force
pause
