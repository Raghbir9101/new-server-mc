@echo off
REM Starts the Spigot server using the local JDK 25 (required by this build).
set "JAVA=E:\games\jdk-25\jdk-25.0.4.1+1\bin\java.exe"
"%JAVA%" -Xmx4G -Xms2G -jar spigot-26.1.2.jar nogui
pause
