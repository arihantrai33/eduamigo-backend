const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const feeReminderJob = require('./src/jobs/feeReminder');
const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/students',       require('./src/routes/studentRoutes'));
app.use('/api/teachers',       require('./src/routes/teacherRoutes'));
app.use('/api/parents',        require('./src/routes/parentRoutes'));
app.use('/api/fees',           require('./src/routes/feeRoutes'));
app.use('/api/attendance',     require('./src/routes/attendanceRoutes'));
app.use('/api/exams',          require('./src/routes/examRoutes'));
app.use('/api/timetable',      require('./src/routes/timetableRoutes'));
app.use('/api/leaves',         require('./src/routes/leaveRoutes'));
app.use('/api/notifications',  require('./src/routes/notificationRoutes'));
app.use("/api/announcements", require("./src/routes/announcementRoutes"));
app.use("/api/events", require("./src/routes/eventRoutes"));
app.use('/api/transport',      require('./src/routes/transportRoutes'));
app.use('/api/users',          require('./src/routes/userRoutes'));
app.use('/api/chat',           require('./src/routes/chatRoutes'));
app.use('/api/notes',          require('./src/routes/noteRoutes'));
app.use('/api/fee-structures', require('./src/routes/feeStructureRoutes'));
app.use('/api/marks',          require('./src/routes/markRoutes'));
app.use('/api/schools',        require('./src/routes/schoolRoutes'));

// Root
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/', (req, res) => {
  res.json({ message: 'EduAmigo Backend Running! 🚀' });
});

// Health check (keeps Render awake)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected!');
    feeReminderJob();
    app.listen(process.env.PORT || 5000, () => {
      console.log(`🚀 Server running on port ${process.env.PORT}`);
    });
  })
  .catch((err) => {
    console.log('❌ MongoDB Error:', err.message);
  });