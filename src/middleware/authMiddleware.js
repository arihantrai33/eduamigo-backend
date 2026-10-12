const jwt = require('jsonwebtoken');
const { enterTenant } = require('../config/tenantGuard');
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { hasPermission } = require('../config/permissions');
const { FEATURES } = require('../config/features');
const { entitlementsFor, hasFeature } = require('../services/subscription');
const { audit } = require('../services/audit');
const { isRevoked } = require('../services/tokens');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Still allowed while a school is read-only, so people can sign in and keep their account secure.
const READ_ONLY_ALLOWED = ['/api/users/password', '/api/users/fcm-token', '/api/users/logout-all'];

const deny = (res, status, message, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

// Verifies the JWT, loads the user, and attaches the tenant (school) and its entitlements to the request.
// Every protected route can rely on req.user, req.schoolId, req.school and req.entitlements being set.
// Safe to run more than once on a request (a mount-level check followed by the router's own).
const protect = async (req, res, next) => {
  if (req.user && req.entitlements) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return deny(res, 401, 'Authentication required');

  let decoded;
  try {
    decoded = jwt.verify(authHeader.slice(7), jwtSecret());
  } catch {
    return deny(res, 401, 'Session expired. Please log in again.');
  }
  // Platform (owner) tokens only work on /api/platform.
  if (decoded.scope === 'platform') return deny(res, 401, 'Authentication required');

  try {
    const user = await User.findById(decoded.id).select('-password')
      .populate('school', '_id name code city isActive branding subscription customDomain');
    if (!user || !user.isActive) return deny(res, 401, 'Account is inactive or no longer exists');
    if (!user.school) return deny(res, 403, 'Account is not linked to a school');
    // Tokens issued before a password change or "sign out everywhere" are no longer valid.
    if (isRevoked(decoded, user)) return deny(res, 401, 'Session expired. Please log in again.');

    const entitlements = await entitlementsFor(user.school);
    if (entitlements.blocked) return deny(res, 403, 'School account is suspended. Please contact EduAmigo support.', 'SCHOOL_SUSPENDED');
    if (entitlements.readOnly && WRITE_METHODS.has(req.method) && !READ_ONLY_ALLOWED.some((p) => req.originalUrl.startsWith(p))) {
      return deny(res, 403, 'Your school\'s EduAmigo subscription has expired. You can view data, but changes are paused until it is renewed.', 'READ_ONLY');
    }

    req.user = user;
    req.school = user.school;
    req.schoolId = user.school._id;
    req.entitlements = entitlements;
    enterTenant(req.schoolId); // from here on the tenant guard checks every query in this request

    // Support session opened by the platform owner: every change made in it is audited.
    if (decoded.imp) {
      req.impersonatedBy = decoded.imp;
      if (WRITE_METHODS.has(req.method)) {
        audit(req, 'support.write', { details: { method: req.method, path: req.originalUrl } });
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

const authorizeRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) return deny(res, 403, 'You do not have permission to perform this action');
  next();
};

// Allows the request if the user's role grants the permission (see config/permissions.js).
const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user?.role, permission)) return deny(res, 403, 'You do not have permission to perform this action');
  next();
};

// Allows the request only if the school's plan includes the feature (see config/features.js).
// Use after protect.
const requireFeature = (feature) => {
  if (!FEATURES[feature]) throw new Error(`Unknown feature: ${feature}`);
  return (req, res, next) => {
    if (!hasFeature(req.entitlements, feature)) {
      return res.status(403).json({
        success: false, code: 'FEATURE_NOT_IN_PLAN', feature,
        message: `${FEATURES[feature].name} is not part of your school's plan. Please contact EduAmigo to add it.`,
      });
    }
    next();
  };
};

module.exports = { protect, authorizeRoles, requirePermission, requireFeature };
