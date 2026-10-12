require('./config/tenantGuard'); // must run before any model is compiled
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { corsOrigins } = require('./config/env');
const { protect, requireFeature } = require('./middleware/authMiddleware');
const { isSchoolDomainOrigin } = require('./services/schoolDirectory');
const { log, errorFields, requestLogger } = require('./utils/logger');
const { apiLimiter } = require('./middleware/rateLimit');

// Mount-level plan check: the whole module belongs to one feature.
const gated = (feature) => [protect, requireFeature(feature)];

function buildApp() {
  const app = express();

  app.set('trust proxy', 1); // Render / Vercel sit behind a proxy
  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const allowed = corsOrigins();
  app.use(cors({
    origin(origin, cb) {
      // Allow server-to-server calls (no Origin), configured frontends and schools' own domains.
      // If CORS_ORIGINS is not set (local development), allow everything.
      if (!origin || !allowed.length || allowed.includes(origin)) return cb(null, true);
      isSchoolDomainOrigin(origin).then((ok) => cb(null, ok), () => cb(null, false));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id'], // so the app can show a support reference when something fails
  }));

  // Payment gateway webhook: needs the exact raw body to check the signature, so it comes before express.json.
  app.post('/api/payments/webhook/:schoolId', express.raw({ type: '*/*', limit: '256kb' }), require('./controllers/paymentController').webhook);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Health check (used by Render and uptime monitors)
  app.get('/api/health', (req, res) => {
    const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db });
  });
  app.get('/', (req, res) => res.json({ message: 'EduAmigo API' }));
  app.use('/api', apiLimiter);

  app.use('/api/public',         require('./routes/publicRoutes'));
  app.use('/api/platform',       require('./routes/platformRoutes'));

  app.use('/api/users',          require('./routes/userRoutes'));
  app.use('/api/schools',        require('./routes/schoolRoutes'));
  app.use('/api/academic',       require('./routes/academicRoutes'));
  app.use('/api/audit',          require('./routes/auditRoutes'));
  app.use('/api/students',       require('./routes/studentRoutes'));
  app.use('/api/teachers',       require('./routes/teacherRoutes'));
  app.use('/api/parents',        require('./routes/parentRoutes'));
  app.use('/api/attendance',     require('./routes/attendanceRoutes'));
  app.use('/api/timetable',      require('./routes/timetableRoutes'));
  app.use('/api/leaves',         require('./routes/leaveRoutes'));
  app.use('/api/notifications',  require('./routes/notificationRoutes'));
  app.use('/api/announcements',  require('./routes/announcementRoutes'));
  app.use('/api/events',         require('./routes/eventRoutes'));
  app.use('/api/bulk',           require('./routes/bulkRoutes'));
  app.use('/api/notes',          require('./routes/noteRoutes'));
  app.use('/api/payments',       require('./routes/paymentRoutes'));   // per-route feature checks
  app.use('/api/transport',      require('./routes/transportRoutes')); // per-route (driver app has no login)

  // Paid modules (see config/features.js)
  app.use('/api/fees',           ...gated('fees'),        require('./routes/feeRoutes'));
  app.use('/api/fee-structures', ...gated('fees'),        require('./routes/feeStructureRoutes'));
  app.use('/api/exams',          ...gated('exams'),       require('./routes/examRoutes'));
  app.use('/api/marks',          ...gated('exams'),       require('./routes/markRoutes'));
  app.use('/api/report-cards',   ...gated('exams'),       require('./routes/reportCardRoutes'));
  app.use('/api/admissions',     ...gated('admissions'),  require('./routes/admissionRoutes'));
  app.use('/api/hr',             ...gated('hr'),          require('./routes/hrRoutes'));
  app.use('/api/library',        ...gated('library'),     require('./routes/libraryRoutes'));
  app.use('/api/chat',           ...gated('chat'),        require('./routes/chatRoutes'));
  app.use('/api/revision',       ...gated('ai_revision'), require('./routes/revisionRoutes'));
  app.use('/api/assistant',      ...gated('ai_assistant'), require('./routes/assistantRoutes'));

  app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));

  // Central error handler: consistent JSON, no stack traces or internals leaked to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Something went wrong';

    if (err.name === 'ValidationError') {
      status = 400;
      message = Object.values(err.errors).map((e) => e.message).join(', ');
    } else if (err.name === 'CastError') {
      status = 400;
      message = `Invalid value for ${err.path}`;
    } else if (err.code === 11000) {
      status = 409;
      message = `A record with the same ${Object.keys(err.keyValue || {}).join(', ') || 'details'} already exists`;
    } else if (err.name === 'MulterError' || err.message === 'Only PDF files are allowed' || err.message === 'Only image files are allowed') {
      status = 400;
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Invalid JSON body';
    }

    if (status >= 500) {
      log.error('request_failed', { requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status, ...errorFields(err) });
      // Only errors written for users (expose: true) keep their message; anything else stays generic.
      if (!err.expose) message = 'Something went wrong. Please try again.';
    }
    res.status(status).json({ success: false, message, ...(status >= 500 ? { requestId: req.id } : {}), ...(err.extra || {}) });
  });

  return app;
}

module.exports = buildApp;
