const Transport = require('../models/Transport');
const Parent    = require('../models/Parent');
const User      = require('../models/User');
const { db }    = require('../config/firebase');
const sendNotification = require('../utils/sendNotification');

const generateDriverToken = (busNumber) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let random = '';
  for (let i = 0; i < 6; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const clean = busNumber.replace(/\s+/g, '').toUpperCase();
  return `${clean}-${random}`;
};

const getDistanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const notifyAllParents = async (bus, title, body) => {
  try {
    const parents = await Parent.find({ children: { $in: bus.assignedStudents } });
    for (const parent of parents) {
      const user = await User.findById(parent.userId);
      if (user?.fcmToken) await sendNotification(user.fcmToken, title, body);
    }
  } catch (err) {
    console.error('notifyAllParents error:', err.message);
  }
};

const notifyStopParents = async (bus, stopIndex, title, body) => {
  try {
    if (stopIndex >= bus.stops.length) return;
    await notifyAllParents(bus, title, body);
  } catch (err) {
    console.error('notifyStopParents error:', err.message);
  }
};

// ══════════════════════════════════════════════════════════════
// ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════

const createBus = async (req, res) => {
  try {
    const { busNumber, driverName, driverPhone, routeName, capacity, stops, serviceArea } = req.body;
    const existing = await Transport.findOne({ busNumber: busNumber.trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Bus number already exists' });
    }
    const driverToken = generateDriverToken(busNumber);
    const firebaseKey = `transport/${driverToken}`;
    const bus = await Transport.create({
      busNumber:      busNumber.trim(),
      driverName,
      driverPhone,
      driverToken,
      routeName,
      capacity:       capacity || 40,
      availableSeats: capacity || 40,
      stops:          stops || [],
      firebaseKey,
      serviceArea:    serviceArea || {},
      school:         req.user.school,
    });
    await db.ref(`transport/${driverToken}`).set({
      busNumber:  bus.busNumber,
      driverName: bus.driverName,
      routeName:  bus.routeName,
      busStatus:  'Idle',
      location:   { lat: 0, lng: 0 },
      updatedAt:  Date.now()
    });
    res.status(201).json({
      success: true,
      message: 'Bus created successfully',
      data: {
        ...bus.toObject(),
        driverLink: `https://eduamigo.app/drive/${driverToken}`
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getAllBuses = async (req, res) => {
  try {
    const buses = await Transport.find()
      .populate('assignedStudents', 'name rollNumber class')
      .populate('boardedStudents',  'name rollNumber class')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: buses.length, data: buses });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getBusById = async (req, res) => {
  try {
    const bus = await Transport.findById(req.params.id)
      .populate('assignedStudents', 'name rollNumber class phone')
      .populate('boardedStudents',  'name rollNumber class');
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.status(200).json({ success: true, data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateBus = async (req, res) => {
  try {
    delete req.body.driverToken;
    delete req.body.firebaseKey;
    const bus = await Transport.findByIdAndUpdate(req.params.id, req.body, {
      new: true, runValidators: true
    });
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    res.status(200).json({ success: true, message: 'Bus updated successfully', data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const deleteBus = async (req, res) => {
  try {
    const bus = await Transport.findByIdAndDelete(req.params.id);
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    await db.ref(`transport/${bus.driverToken}`).remove();
    res.status(200).json({ success: true, message: 'Bus deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const assignStudent = async (req, res) => {
  try {
    const { studentId } = req.body;
    const bus = await Transport.findById(req.params.id);
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    if (bus.assignedStudents.includes(studentId)) {
      return res.status(400).json({ success: false, message: 'Student already assigned to this bus' });
    }
    bus.assignedStudents.push(studentId);
    await bus.save();
    res.status(200).json({ success: true, message: 'Student assigned successfully', data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const removeStudent = async (req, res) => {
  try {
    const { studentId } = req.body;
    const bus = await Transport.findById(req.params.id);
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    bus.assignedStudents = bus.assignedStudents.filter(id => id.toString() !== studentId);
    await bus.save();
    res.status(200).json({ success: true, message: 'Student removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const resetDriverToken = async (req, res) => {
  try {
    const bus = await Transport.findById(req.params.id);
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    const oldToken  = bus.driverToken;
    const newToken  = generateDriverToken(bus.busNumber);
    bus.driverToken = newToken;
    bus.firebaseKey = `transport/${newToken}`;
    await bus.save();
    await db.ref(`transport/${oldToken}`).remove();
    await db.ref(`transport/${newToken}`).set({
      busNumber:  bus.busNumber,
      driverName: bus.driverName,
      routeName:  bus.routeName,
      busStatus:  'Idle',
      location:   { lat: 0, lng: 0 },
      updatedAt:  Date.now()
    });
    res.status(200).json({
      success: true,
      message: 'Driver token reset successfully',
      data: {
        driverToken: newToken,
        driverLink:  `https://eduamigo.app/drive/${newToken}`
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// DRIVER CONTROLLERS
// ══════════════════════════════════════════════════════════════

const getDriverBusInfo = async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token })
      .populate('assignedStudents', 'name rollNumber class');
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid driver token' });
    res.status(200).json({ success: true, data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const startTrip = async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid driver token' });
    if (bus.busStatus === 'On Route') {
      return res.status(400).json({ success: false, message: 'Trip is already in progress' });
    }
    bus.stops.forEach(stop => {
      stop.status     = 'Pending';
      stop.departedAt = undefined;
    });
    if (bus.stops.length > 0) bus.stops[0].status = 'Live';
    bus.busStatus        = 'On Route';
    bus.tripStartedAt    = new Date();
    bus.tripEndedAt      = undefined;
    bus.currentStopIndex = 0;
    bus.boardedStudents  = [];
    bus.availableSeats   = bus.capacity;
    await bus.save();
    await db.ref(`transport/${bus.driverToken}`).update({
      busStatus:        'On Route',
      currentStopIndex: 0,
      tripStartedAt:    Date.now(),
      stops: bus.stops.map(s => ({
        name:          s.name,
        status:        s.status,
        estimatedTime: s.estimatedTime
      })),
      updatedAt: Date.now()
    });
    notifyAllParents(bus, '🚌 Bus Nikli!', `${bus.busNumber} - ${bus.routeName} route pe trip shuru ho gayi`);
    res.status(200).json({ success: true, message: 'Trip started successfully', data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const markStopDone = async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid driver token' });
    if (bus.busStatus !== 'On Route') {
      return res.status(400).json({ success: false, message: 'No active trip found' });
    }
    const idx = bus.currentStopIndex;
    if (idx >= bus.stops.length) {
      return res.status(400).json({ success: false, message: 'All stops have been completed' });
    }
    bus.stops[idx].status     = 'Departed';
    bus.stops[idx].departedAt = new Date();
    if (idx + 1 < bus.stops.length) bus.stops[idx + 1].status = 'Live';
    bus.currentStopIndex = idx + 1;
    await bus.save();
    await db.ref(`transport/${bus.driverToken}`).update({
      currentStopIndex: idx + 1,
      stops: bus.stops.map(s => ({
        name:          s.name,
        status:        s.status,
        estimatedTime: s.estimatedTime
      })),
      updatedAt: Date.now()
    });
    const nextStop = bus.stops[idx + 1];
    if (nextStop) {
      notifyStopParents(bus, idx + 1, '📍 Bus Paas Aa Rahi Hai!', `Bus "${nextStop.name}" stop pe pahunchne wali hai`);
    }
    res.status(200).json({
      success:       true,
      message:       `Stop "${bus.stops[idx].name}" marked as completed`,
      completedStop: bus.stops[idx],
      nextStop:      bus.stops[idx + 1] || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const endTrip = async (req, res) => {
  try {
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid driver token' });
    if (bus.busStatus !== 'On Route') {
      return res.status(400).json({ success: false, message: 'No active trip found' });
    }
    bus.busStatus       = 'Completed';
    bus.tripEndedAt     = new Date();
    bus.boardedStudents = [];
    await bus.save();
    await db.ref(`transport/${bus.driverToken}`).update({
      busStatus:   'Completed',
      tripEndedAt: Date.now(),
      location:    { lat: 0, lng: 0 },
      updatedAt:   Date.now()
    });
    notifyAllParents(bus, '✅ Baccha School Pahunch Gaya!', `${bus.busNumber} ki trip complete ho gayi. Aapka baccha school mein safe hai.`);
    res.status(200).json({ success: true, message: 'Trip completed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// DRIVER LOCATION UPDATE
// ══════════════════════════════════════════════════════════════

const updateLocation = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const bus = await Transport.findOne({ driverToken: req.params.token });
    if (!bus) return res.status(404).json({ success: false, message: 'Invalid driver token' });
    if (bus.busStatus !== 'On Route') {
      return res.status(400).json({ success: false, message: 'No active trip found' });
    }
    await db.ref(`transport/${bus.driverToken}/location`).set({
      lat, lng, updatedAt: Date.now()
    });
    res.status(200).json({ success: true, message: 'Location updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// STUDENT CONTROLLERS
// ══════════════════════════════════════════════════════════════

const getMyBus = async (req, res) => {
  try {
    const bus = await Transport.findOne({
      $or: [
        { assignedStudents: req.user.id },
        { boardedStudents:  req.user.id }
      ]
    });
    if (!bus) return res.status(404).json({ success: false, message: 'No bus assigned' });
    res.status(200).json({ success: true, data: bus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getNearbyBuses = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng are required' });
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const activeBuses = await Transport.find({ busStatus: 'On Route', availableSeats: { $gt: 0 } });
    const nearby = activeBuses
      .map(bus => {
        const distance = getDistanceKm(userLat, userLng, bus.serviceArea?.latitude || 0, bus.serviceArea?.longitude || 0);
        return { bus, distance: parseFloat(distance.toFixed(2)) };
      })
      .filter(item => item.distance <= 5)
      .sort((a, b) => a.distance - b.distance)
      .map(item => ({
        _id:            item.bus._id,
        busNumber:      item.bus.busNumber,
        driverName:     item.bus.driverName,
        driverPhone:    item.bus.driverPhone,
        routeName:      item.bus.routeName,
        availableSeats: item.bus.availableSeats,
        firebaseKey:    item.bus.firebaseKey,
        distanceKm:     item.distance
      }));
    res.status(200).json({ success: true, count: nearby.length, data: nearby });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const boardBus = async (req, res) => {
  try {
    const bus = await Transport.findById(req.params.id);
    if (!bus) return res.status(404).json({ success: false, message: 'Bus not found' });
    if (bus.busStatus !== 'On Route') return res.status(400).json({ success: false, message: 'Bus is not active' });
    if (bus.availableSeats <= 0) return res.status(400).json({ success: false, message: 'Bus is at full capacity' });
    const studentId = req.user.id;
    if (bus.boardedStudents.includes(studentId)) {
      return res.status(400).json({ success: false, message: 'Student already boarded this bus' });
    }
    bus.boardedStudents.push(studentId);
    bus.availableSeats -= 1;
    await bus.save();
    res.status(200).json({
      success: true,
      message: 'Boarded successfully',
      data: {
        busNumber:   bus.busNumber,
        driverName:  bus.driverName,
        driverPhone: bus.driverPhone,
        firebaseKey: bus.firebaseKey
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PARENT CONTROLLERS
// ══════════════════════════════════════════════════════════════

const getChildBus = async (req, res) => {
  try {
    const parent = await Parent.findOne({ userId: req.user.id });
    if (!parent || !parent.children || parent.children.length === 0) {
      return res.status(404).json({ success: false, message: 'No children linked to this account' });
    }
    const bus = await Transport.findOne({
      $or: [
        { assignedStudents: { $in: parent.children } },
        { boardedStudents:  { $in: parent.children } }
      ]
    });
    if (!bus) return res.status(404).json({ success: false, message: 'No bus found for your child' });

    const Student = require('../models/Student');
    const student = await Student.findById(parent.children[0]);

    res.status(200).json({
      success: true,
      data: {
        _id:              bus._id,
        busNumber:        bus.busNumber,
        driverName:       bus.driverName,
        driverPhone:      bus.driverPhone,
        routeName:        bus.routeName,
        busStatus:        bus.busStatus,
        firebasePath:     bus.driverToken,   // ✅ frontend Firebase ke liye
        stops:            bus.stops,          // ✅ real stops from DB
        currentStopIndex: bus.currentStopIndex,
        studentName:      student?.name || 'Your Child',
        studentClass:     student?.class
          ? `Class ${student.class}${student.section || ''}`
          : '—',
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
module.exports = {
  createBus, getAllBuses, getBusById, updateBus,
  deleteBus, assignStudent, removeStudent, resetDriverToken,
  getDriverBusInfo, startTrip, markStopDone, endTrip,
  updateLocation,
  getMyBus, getNearbyBuses, boardBus,
  getChildBus
};