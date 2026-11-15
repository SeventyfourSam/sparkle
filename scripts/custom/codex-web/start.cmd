@echo off
node "%~dp0server.cjs" %*
exit /b %errorlevel%
