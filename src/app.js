const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { corsOrigins } = require('./config/env');

function buildApp() {
  const app = express();

  app.set('trust proxy', 1); // Render / Vercel sit behind a proxy
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const allowed = corsOrigins();
  app.use(cors({
    origin(origin, cb) {
      // Allow server-to-server calls (no Origin) and configured frontends.
      // If CORS_ORIGINS is not set (local development), allow everything.
      if (!origin || !allowed.length || allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Health check (used by Render and uptime monitors)
  app.get('/api/health', (req, res) => {
    const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db });
  });
  app.get('/', (req, res) => res.json({ message: 'EduAmigo API' }));

  app.use('/api/users',          require('./routes/userRoutes'));
  app.use('/api/schools',        require('./routes/schoolRoutes'));
  app.use('/api/students',       require('./routes/studentRoutes'));
  app.use('/api/teachers',       require('./routes/teacherRoutes'));
  app.use('/api/parents',        require('./routes/parentRoutes'));
  app.use('/api/fees',           require('./routes/feeRoutes'));
  app.use('/api/fee-structures', require('./routes/feeStructureRoutes'));
  app.use('/api/attendance',     require('./routes/attendanceRoutes'));
  app.use('/api/exams',          require('./routes/examRoutes'));
  app.use('/api/marks',          require('./routes/markRoutes'));
  app.use('/api/timetable',      require('./routes/timetableRoutes'));
  app.use('/api/leaves',         require('./routes/leaveRoutes'));
  app.use('/api/notifications',  require('./routes/notificationRoutes'));
  app.use('/api/announcements',  require('./routes/announcementRoutes'));
  app.use('/api/events',         require('./routes/eventRoutes'));
  app.use('/api/bulk',           require('./routes/bulkRoutes'));
  app.use('/api/hr',             require('./routes/hrRoutes'));
  app.use('/api/transport',      require('./routes/transportRoutes'));
  app.use('/api/chat',           require('./routes/chatRoutes'));
  app.use('/api/notes',          require('./routes/noteRoutes'));
  app.use('/api/revision',       require('./routes/revisionRoutes'));
  app.use('/api/library',        require('./routes/libraryRoutes'));
  app.use('/api/report-cards',   require('./routes/reportCardRoutes'));

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
      console.error(`[${req.method} ${req.originalUrl}]`, err);
      message = 'Something went wrong. Please try again.';
    }
    res.status(status).json({ success: false, message, ...(err.extra || {}) });
  });

  return app;
}

module.exports = buildApp;
