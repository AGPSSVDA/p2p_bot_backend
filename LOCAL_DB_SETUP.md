# Local Database Setup Guide 🗄️

## For Windows Users

---

## Step 1: Install MySQL Server

### Download
1. Go to: https://dev.mysql.com/downloads/mysql/
2. Select **MySQL 8.0** (latest stable)
3. Download **Windows (x86, 64-bit)** installer

### Install
1. Run the installer
2. Choose **Setup Type**: `Developer Default`
3. Choose **Server Configuration Type**: `Development Machine`
4. **Port**: Keep default `3306`
5. **MySQL Server Instance Configuration**:
   - Config Type: `Development Machine`
   - TCP Port: `3306`
   - Windows Service Name: `MySQL80`
6. **MySQL Server User Configuration**:
   - Username: `root`
   - Password: `root` (or anything you want)
7. Complete installation

### Verify Installation
```bash
mysql --version
# Output: mysql  Ver 8.0.xx for win64 on x86_64
```

---

## Step 2: Start MySQL Service

### Option A: Automatic (Recommended)
```bash
# Already running as Windows Service after installation
# Verify it's running:
sc query MySQL80

# If not running, start it:
net start MySQL80
```

### Option B: Manual Start
```bash
# If installed locally without service:
mysqld
```

---

## Step 3: Connect to MySQL

### Open MySQL Command Line
```bash
mysql -u root -p
# When prompted, enter password (default: root)
```

You should see:
```
Welcome to the MySQL monitor.
mysql>
```

---

## Step 4: Create Database and User

### Run These Commands

```sql
-- 1. Create database
CREATE DATABASE agpssvda1_p2p CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Create user
CREATE USER 'agpssvda1_p2p_user'@'localhost' IDENTIFIED BY 'Createmy@123456';

-- 3. Grant permissions
GRANT ALL PRIVILEGES ON agpssvda1_p2p.* TO 'agpssvda1_p2p_user'@'localhost';
GRANT ALL PRIVILEGES ON *.* TO 'agpssvda1_p2p_user'@'localhost' WITH GRANT OPTION;

-- 4. Flush privileges
FLUSH PRIVILEGES;

-- 5. Verify
SHOW DATABASES;
SELECT User, Host FROM mysql.user;
```

Expected Output:
```
+--------------------+
| Database           |
+--------------------+
| agpssvda1_p2p      |
| mysql              |
| performance_schema |
+--------------------+
```

---

## Step 5: Update .env File

Edit `c:\users\dell\my-projects\p2p-bot-backend-client-git\.env`:

```env
# Local Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_USER=agpssvda1_p2p_user
DB_PASS=Createmy@123456
DB_NAME=agpssvda1_p2p
```

---

## Step 6: Run Database Migration

```bash
cd c:\users\dell\my-projects\p2p-bot-backend-client-git
node run-migration.js
```

You should see:
```
📦 Reading migration file...
🚀 Running migration on database: agpssvda1_p2p
✅ Migration completed successfully!

✅ Created tables:
   - seller_ads
   - seller_ad_rules
   - seller_orders
   - seller_order_messages
   - seller_order_state_log
   - seller_payment_history
   - seller_verification_documents
   - seller_buyer_metrics
```

---

## Step 7: Verify Database Setup

### Connect and Check
```bash
mysql -u agpssvda1_p2p_user -p agpssvda1_p2p -h localhost

# Inside MySQL:
SHOW TABLES;
```

Expected output:
```
+--------------------------------+
| Tables_in_agpssvda1_p2p        |
+--------------------------------+
| seller_ad_rules                |
| seller_ads                     |
| seller_buyer_metrics           |
| seller_order_messages          |
| seller_order_state_log         |
| seller_orders                  |
| seller_payment_history         |
| seller_verification_documents  |
+--------------------------------+
```

---

## Step 8: Start Backend

```bash
cd c:\users\dell\my-projects\p2p-bot-backend-client-git
npm start
```

You should see:
```
✅ Database schema initialized.
✅ MySQL connected successfully.
✅ MySQL schema initialized.
✅ Binance clock synced
✅ OrderPoller started
✅ Bot is running. Waiting for new P2P orders...
🌐 API server listening on http://localhost:5000
```

---

## Troubleshooting

### ❌ "Can't connect to MySQL server"
```bash
# 1. Check if MySQL is running
tasklist | find "mysqld"

# 2. Start MySQL service
net start MySQL80

# 3. Verify connection
mysql -u root -p
```

### ❌ "Access denied for user 'agpssvda1_p2p_user'"
```sql
-- Reset user password
ALTER USER 'agpssvda1_p2p_user'@'localhost' IDENTIFIED BY 'Createmy@123456';
FLUSH PRIVILEGES;
```

### ❌ "Database already exists"
```sql
DROP DATABASE agpssvda1_p2p;
-- Then run Step 4 again
```

### ❌ "Port 3306 already in use"
```bash
# Find process using port 3306
netstat -ano | findstr :3306

# Kill the process (if needed)
taskkill /PID <PID> /F
```

---

## Quick Checklist

- [ ] MySQL installed and running
- [ ] Database created: `agpssvda1_p2p`
- [ ] User created: `agpssvda1_p2p_user`
- [ ] User has full permissions
- [ ] .env configured with correct database details
- [ ] Migration ran successfully (8 tables created)
- [ ] Backend starts without database errors

---

## Database Connection Test

```bash
# Quick test from backend project
node -e "
const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });
    console.log('✅ Database connected successfully!');
    await conn.end();
  } catch(e) {
    console.error('❌ Connection failed:', e.message);
  }
})();
"
```

---

## Common Ports and Services

- MySQL: `localhost:3306`
- Backend API: `localhost:5000`
- Frontend: `localhost:3000`

---

## Next Steps

1. ✅ Local database ready
2. ✅ Backend running on `localhost:5000`
3. ✅ Frontend ready on `localhost:3000`
4. ✅ Sync ads from Binance
5. ✅ Start processing orders

---

## Database Admin Tools (Optional)

### MySQL Workbench
- Download: https://dev.mysql.com/downloads/workbench/
- GUI tool to manage databases
- More user-friendly than command line

### phpMyAdmin
```bash
# If you have PHP installed:
# Download phpMyAdmin and place in web server
# Access via: http://localhost/phpmyadmin
```

---

**Database setup complete! Ready to sync seller ads?** 🎉
