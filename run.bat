@echo off
clear
del code.exe
python bf2exe.py code.bf code.exe --cn
pause
clear
echo Running code.exe...
code.exe
pause