# Local Database Setup Guide (हिंदी)

Windows पर Local MySQL Database Setup करने के लिए यह guide follow करें।

---

## Step 1: MySQL Server Install करें

### Download करें
1. जाएँ: https://dev.mysql.com/downloads/mysql/
2. **MySQL 8.0** चुनें (latest version)
3. **Windows (x86, 64-bit)** installer download करें

### Install करें
1. Installer को run करें
2. **Setup Type**: `Developer Default` चुनें
3. **Server Configuration**: `Development Machine` चुनें
4. **Port**: Default `3306` रखें
5. **MySQL Configuration**:
   - Type: `Development Machine`
   - Port: `3306`
   - Service Name: `MySQL80`
6. **User Configuration**:
   - Username: `root`
   - Password: `root` (या कोई भी password)
7. Install complete करें

### Check करें कि Install हुआ या नहीं
```bash
mysql --version
# Output दिखेगा: mysql  Ver 8.0.xx for win64
```

---

## Step 2: MySQL Service Start करें

### Auto Start (सबसे आसान)
```bash
# Installation के बाद automatic चलता है
# Check करने के लिए:
sc query MySQL80

# अगर नहीं चल रहा:
net start MySQL80
```

---

## Step 3: MySQL से Connect करें

### Command Line खोलें
```bash
mysql -u root -p
# Password पूछेगा (default: root)
```

आपको यह दिखेगा:
```
Welcome to the MySQL monitor.
mysql>
```

---

## Step 4: Database और User बनाएं

### यह Commands चलाएं

```sql
-- 1. Database बनाएं
CREATE DATABASE agpssvda1_p2p CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. User बनाएं
CREATE USER 'agpssvda1_p2p_user'@'localhost' IDENTIFIED BY 'Createmy@123456';

-- 3. Permissions दें
GRANT ALL PRIVILEGES ON agpssvda1_p2p.* TO 'agpssvda1_p2p_user'@'localhost';
GRANT ALL PRIVILEGES ON *.* TO 'agpssvda1_p2p_user'@'localhost' WITH GRANT OPTION;

-- 4. Flush करें
FLUSH PRIVILEGES;

-- 5. Check करें
SHOW DATABASES;
SELECT User, Host FROM mysql.user;
```

अगर सही है तो यह दिखेगा:
```
+--------------------+
| Database           |
+--------------------+
| agpssvda1_p2p      |  ← यह database है
| mysql              |
| performance_schema |
+--------------------+
```

---

## Step 5: .env File Update करें

फ़ाइल खोलें: `c:\users\dell\my-projects\p2p-bot-backend-client-git\.env`

यह lines add करें या update करें:

```env
# Local Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_USER=agpssvda1_p2p_user
DB_PASS=Createmy@123456
DB_NAME=agpssvda1_p2p
```

---

## Step 6: Database Migration चलाएं

```bash
cd c:\users\dell\my-projects\p2p-bot-backend-client-git
node run-migration.js
```

यह दिखेगा:
```
📦 Reading migration file...
🚀 Running migration on database: agpssvda1_p2p
✅ Migration completed successfully!

✅ Created tables:
   - seller_ads
   - seller_ad_rules
   - seller_orders
   ... (और भी tables)
```

---

## Step 7: Database को Verify करें

```bash
# MySQL से connect करें
mysql -u agpssvda1_p2p_user -p agpssvda1_p2p

# Tables list देखें
SHOW TABLES;
```

Output में 8 tables दिखेंगी:
```
seller_ads
seller_ad_rules
seller_orders
seller_order_messages
seller_order_state_log
seller_payment_history
seller_verification_documents
seller_buyer_metrics
```

---

## Step 8: Backend Start करें

```bash
cd c:\users\dell\my-projects\p2p-bot-backend-client-git
npm start
```

यह दिखेगा:
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

## Problem Solving

### ❌ "Can't connect to MySQL server"

```bash
# 1. Check करें MySQL चल रहा है?
tasklist | find "mysqld"

# 2. MySQL start करें
net start MySQL80

# 3. Connection test करें
mysql -u root -p
```

### ❌ "Access denied for user"

```sql
-- Password reset करें
ALTER USER 'agpssvda1_p2p_user'@'localhost' IDENTIFIED BY 'Createmy@123456';
FLUSH PRIVILEGES;
```

### ❌ "Database already exists"

```sql
-- पहले database delete करें
DROP DATABASE agpssvda1_p2p;
-- फिर Step 4 फिर से करें
```

### ❌ "Port 3306 already in use"

```bash
# कौन सी process port use कर रही है?
netstat -ano | findstr :3306

# Process को kill करें
taskkill /PID <PID> /F
```

---

## Setup Complete Checklist ✅

- [ ] MySQL install और चल रहा है
- [ ] Database created: `agpssvda1_p2p`
- [ ] User created: `agpssvda1_p2p_user`
- [ ] User को full permissions हैं
- [ ] .env में correct database details हैं
- [ ] Migration successfully चल गया (8 tables बन गई)
- [ ] Backend start होता है बिना database error

---

## Quick Connection Test

```bash
# Terminal में यह command चलाएं:
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

## Default Ports और Services

- MySQL: `localhost:3306`
- Backend API: `localhost:5000`
- Frontend: `localhost:3000`

---

## Optional: Admin Tools

### MySQL Workbench (GUI)
- Download करें: https://dev.mysql.com/downloads/workbench/
- Command line से बेहतर है
- Visual interface में databases manage कर सकते हैं

### phpMyAdmin
- अगर PHP install है तो use कर सकते हैं
- Browser में open करते हैं

---

## Next Steps

1. ✅ Local database ready
2. ✅ Backend running on `localhost:5000`
3. ✅ Frontend ready on `localhost:3000`
4. ✅ Seller ads sync करें Binance से
5. ✅ Orders process करना शुरू करें

---

**Database setup complete! अब Seller ads sync कर सकते हैं!** 🎉

---

## Extra Information

### Seller के लिए Binance API Keys

.env में add करें:

```env
# Buyer के लिए (पहले से है)
BINANCE_API_KEY=your_buyer_key
BINANCE_SECRET_KEY=your_buyer_secret

# Seller के लिए (अलग account)
BINANCE_SELLER_API_KEY=your_seller_key
BINANCE_SELLER_SECRET_KEY=your_seller_secret

# Seller का Binance Merchant ID
SELLER_ID=1135945063
SELLER_NAME=AGPSS GLOBAL PRIVATE LIMITED
```

---

**कोई सवाल हो तो पूछें!** 💬
