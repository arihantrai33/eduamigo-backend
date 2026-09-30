const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { hasPermission } = require('../config/permissions');

// Verifies the JWT, loads the user, and attaches the tenant (school) to the request.
// Every protected route can rely on req.user and req.schoolId being set.
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.slice(7), jwtSecret());
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }

  try {
    const user = await User.findById(decoded.id).select('-password').populate('school', '_id name isActive');
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is inactive or no longer exists' });
    }
    if (!user.school) {
      return res.status(403).json({ success: false, message: 'Account is not linked to a school' });
    }
    if (user.school.isActive === false) {
      return res.status(403).json({ success: false, message: 'School account is suspended' });
    }
    // Tokens issued before a password change are no longer valid.
    if (user.passwordChangedAt && decoded.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }

    req.user = user;
    req.schoolId = user.school._id;
    next();
  } catch (error) {
    next(error);
  }
};

const authorizeRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'You do not have permission to perform this action' });
  }
  next();
};

// Allows the request if the user's role grants the permission (see config/permissions.js).
const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user?.role, permission)) {
    return res.status(403).json({ success: false, message: 'You do not have permission to perform this action' });
  }
  next();
};

module.exports = { protect, authorizeRoles, requirePermission };
