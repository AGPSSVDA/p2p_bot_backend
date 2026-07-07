@echo off
REM Setup Local MySQL Database with XAMPP
REM This script creates the database and runs migrations

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  P2P Bot - Local MySQL Database Setup (XAMPP)    ║
echo ╚══════════════════════════════════════════════════╝
echo.

REM Step 1: Create Database
echo 📦 Creating database 'agpssvda'...
mysql -u root -e "CREATE DATABASE IF NOT EXISTS agpssvda;" 2>nul

if %ERRORLEVEL% EQU 0 (
    echo ✅ Database created successfully!
) else (
    echo ❌ Failed to create database. Check if MySQL is running.
    echo.
    echo 🔧 Make sure:
    echo    1. XAMPP Control Panel is open
    echo    2. MySQL service is RUNNING
    echo    3. Try again
    pause
    exit /b 1
)

REM Step 2: Run Seller Tables Migration
echo.
echo 📋 Running seller tables migration...
mysql -u root agpssvda < migrations\seller_tables.sql 2>nul

if %ERRORLEVEL% EQU 0 (
    echo ✅ Seller tables created successfully!
) else (
    echo ❌ Failed to run migration.
    pause
    exit /b 1
)

REM Step 3: Verify Tables
echo.
echo 🔍 Verifying tables...
mysql -u root agpssvda -e "SHOW TABLES;" 2>nul

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║         ✅ Local Database Setup Complete!        ║
echo ╚══════════════════════════════════════════════════╝
echo.
echo Next steps:
echo 1. Start Backend: npm start
echo 2. Go to frontend: http://localhost:5173
echo 3. Click "Sync Ads" to test
echo.
pause
