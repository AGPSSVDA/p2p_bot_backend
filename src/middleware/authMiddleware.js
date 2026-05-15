const jwt = require("jsonwebtoken");
const { pool } = require("../config/mysql");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided, authorization denied",
        data: null
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");

    // Verify the token's login_id matches the one stored for the user.
    // Mismatch means the user has logged in elsewhere or logged out.
    const [rows] = await pool.query("SELECT login_id FROM users WHERE id = ?", [decoded.id]);
    const currentLoginId = rows[0] && rows[0].login_id;

    if (!currentLoginId || currentLoginId !== decoded.login_id) {
      return res.status(401).json({
        success: false,
        message: "Session expired. You have been logged in from another device.",
        data: null
      });
    }

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({
      success: false,
      message: "Token is not valid",
      data: null
    });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "Access denied. Admin only.",
      data: null
    });
  }
};

// Lighter middleware for idempotent endpoints like /logout.
// Verifies the JWT signature but does NOT enforce the login_id match,
// so a user whose session was superseded (or already cleared) can still log out.
const verifyTokenOnly = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided, authorization denied",
        data: null
      });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({
      success: false,
      message: "Token is not valid",
      data: null
    });
  }
};

module.exports = { authMiddleware, adminMiddleware, verifyTokenOnly };
