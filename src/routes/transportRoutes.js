const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Transport = require('../models/Transport');
const Student = require('../models/Student');
const Parent = require('../models/Parent');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const crypto = require('crypto');

const makeToken = (busNumber) => {
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  const clean = busNumber.replace(/\s+/g, '').toUpperCase();
  return `${clean}-${rand}`;
};

// ─────────────────────────────────────────
// PARENT — must be BEFORE /:id routes
// ─────────────────────────────────────────
router.get('/my-child-bus', protect, async (req, res) => {
  try {
    let student;
    if (req.user.role === 'student') {
      student = await Student.findOne({ userId: req.user._id }).populate({
        path: 'bus',
        select: 'busNumber driverName driverPhone routeName firebaseKey driverToken busStatus stops currentStopIndex',
      });
    } else {
      const parent = await Parent.findOne({ userId: req.user._id }).populate('children');
      if (!parent || !parent.children.length) {
        return res.status(404).json({ success: false, message: 'No children linked to this account' });
      }
      const child = parent.children[0];
      student = await Student.findById(child._id).populate({
        path: 'bus',
        select: 'busNumber driverName driverPhone routeName firebaseKey driverToken busStatus stops currentStopIndex',
      });
    }
    if (!student?.bus) {
      return res.status(404).json({ success: false, message: 'No bus assigned' });
    }
    const bus = student.bus;
    res.json({
      success: true,
      data: {
        _id:              bus._id,
        busNumber:        bus.busNumber,
        driverName:       bus.driverName,
        driverPhone:      bus.driverPhone,
        routeName:        bus.routeName,
        busStatus:        bus.busStatus,
        firebasePath:     bus.driverToken,
        stops:            bus.stops,
        currentStopIndex: bus.currentStopIndex,
        studentName:      student.name,
        studentClass:     student.class
          ? `Class ${student.class}${student.section ? '-' + student.section : ''}`
          : '—',
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────
router.get('/', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const buses = await Transport.find({ school: req.user.school })
      .populate('assignedStudents', 'name rollNumber class section');
    res.json({ success: true, data: buses });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const { busNumber, driverName, driverPhone, routeName, capacity, stops } = req.body;
    const existing = await Transport.findOne({ busNumber: busNumber.trim(), school: req.user.school });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Bus number already exists' });
    }
    const driverToken = makeToken(busNumber);
    const firebaseKey = `transport/${driverToken}`;
    const bus = await Transport.create({
      school: req.user.school,
      busNumber: busNumber.trim(),
      driverName, driverPhone, routeName,
      capacity:     capacity || 40,
      availableSeats: capacity || 40,
      driverToken,
      firebaseKey,
      stops: stops || [],
    });
    res.status(201).json({ success: true, data: bus });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

router.get('/students', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const students = await Student.find({ school: req.user.school, isActive: true })
      .select('name rollNumber class section bus')
      .populate('bus', 'busNumber');
    res.json({ success: true, data: students });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/:id', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const { busNumber, driverName, driverPhone, routeName, capacity } = req.body;
    const bus = await Transport.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { busNumber, driverName, driverPhone, routeName, capacity },
      { new: true, runValidators: true }
    );
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.json({ success: true, data: bus });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

router.put('/:id/stops', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const bus = await Transport.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { stops: req.body.stops },
      { new: true }
    );
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.json({ success: true, data: bus });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

router.put('/:id/assign-students', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const { studentIds } = req.body;
    const objectIds = studentIds.map(id => new mongoose.Types.ObjectId(id));
    const bus = await Transport.findOne({ _id: req.params.id, school: req.user.school });
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    await Student.updateMany({ bus: bus._id }, { $set: { bus: null } });
    await Student.updateMany({ _id: { $in: objectIds } }, { $set: { bus: bus._id } });
    bus.assignedStudents = objectIds;
    await bus.save();
    const updatedBus = await Transport.findById(bus._id)
      .populate('assignedStudents', 'name rollNumber class section');
    res.json({ success: true, data: updatedBus });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

router.delete('/:id', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const bus = await Transport.findOne({ _id: req.params.id, school: req.user.school });
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    await Student.updateMany({ bus: bus._id }, { $set: { bus: null } });
    await bus.deleteOne();
    res.json({ success: true, message: 'Bus deleted' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────
// DRIVER
// ─────────────────────────────────────────
router.get('/driver/:token', async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token })
      .populate('assignedStudents', 'name rollNumber class');
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid token' });
    res.json({ success: true, data: bus });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/driver/:token/start-trip', async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid token' });
    bus.stops.forEach(stop => {
      stop.status     = 'Pending';
      stop.departedAt = undefined;
    });
    if (bus.stops.length > 0) bus.stops[0].status = 'Live';
    bus.busStatus        = 'On Route';
    bus.currentStopIndex = 0;
    bus.tripStartedAt    = new Date();
    bus.tripEndedAt      = undefined;
    bus.boardedStudents  = [];
    bus.availableSeats   = bus.capacity;
    await bus.save();
    const { db } = require('../config/firebase');
    await db.ref(`transport/${bus.driverToken}`).update({
      busStatus:        'On Route',
      currentStopIndex: 0,
      tripStartedAt:    Date.now(),
      updatedAt:        Date.now(),
    });
    res.json({ success: true, data: bus });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/driver/:token/stop-done', async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid token' });
    const idx = bus.currentStopIndex;
    if (idx < bus.stops.length) {
      bus.stops[idx].status     = 'Departed';
      bus.stops[idx].departedAt = new Date();
      if (idx + 1 < bus.stops.length) bus.stops[idx + 1].status = 'Live';
    }
    bus.currentStopIndex = idx + 1;
    await bus.save();
    const { db } = require('../config/firebase');
    await db.ref(`transport/${bus.driverToken}`).update({
      currentStopIndex: bus.currentStopIndex,
      updatedAt:        Date.now(),
    });
    res.json({ success: true, data: bus });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/driver/:token/end-trip', async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid token' });
    bus.busStatus       = 'Completed';
    bus.tripEndedAt     = new Date();
    bus.boardedStudents = [];
    await bus.save();
    const { db } = require('../config/firebase');
    await db.ref(`transport/${bus.driverToken}`).update({
      busStatus:   'Completed',
      tripEndedAt: Date.now(),
      location:    { lat: 0, lng: 0 },
      updatedAt:   Date.now(),
    });
    res.json({ success: true, message: 'Trip ended successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/driver/:token/update-location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid token' });
    if (bus.busStatus !== 'On Route') {
      return res.status(400).json({ success: false, message: 'Trip not active' });
    }
    const { db } = require('../config/firebase');
    await db.ref(`transport/${bus.driverToken}/location`).set({ lat, lng, updatedAt: Date.now() });
    res.json({ success: true, message: 'Location updated' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;