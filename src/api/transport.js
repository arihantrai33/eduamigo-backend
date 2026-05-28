// src/api/transport.js
import axios from 'axios';

const API = import.meta.env.VITE_API_URL;

const authHeader = () => ({
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

// ─────────────────────────────────────────
// PARENT
// ─────────────────────────────────────────

export const getChildBus = async () => {
  try {
    const res = await axios.get(`${API}/transport/my-child-bus`, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to fetch child bus details' };
  }
};

// ─────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────

export const getAllBuses = async () => {
  try {
    const res = await axios.get(`${API}/transport`, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to fetch buses' };
  }
};

export const createBus = async (data) => {
  try {
    const res = await axios.post(`${API}/transport`, data, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to create bus' };
  }
};

export const updateBus = async (id, data) => {
  try {
    const res = await axios.put(`${API}/transport/${id}`, data, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to update bus' };
  }
};

export const updateBusStops = async (id, stops) => {
  try {
    const res = await axios.put(`${API}/transport/${id}/stops`, { stops }, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to update bus stops' };
  }
};

export const assignStudents = async (busId, studentIds) => {
  try {
    const res = await axios.put(
      `${API}/transport/${busId}/assign-students`,
      { studentIds },
      authHeader()
    );
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to assign students to bus' };
  }
};

export const deleteBus = async (id) => {
  try {
    const res = await axios.delete(`${API}/transport/${id}`, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to delete bus' };
  }
};

export const getStudentsForBus = async () => {
  try {
    const res = await axios.get(`${API}/transport/students`, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to fetch students for bus' };
  }
};

// ─────────────────────────────────────────
// DRIVER
// ─────────────────────────────────────────

export const getDriverBus = async (token) => {
  try {
    const res = await axios.get(`${API}/transport/driver/${token}`, authHeader());
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to fetch driver bus details' };
  }
};

export const startTrip = async (token) => {
  try {
    const res = await axios.patch(
      `${API}/transport/driver/${token}/start-trip`,
      {},
      authHeader()
    );
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to start trip' };
  }
};

export const markStopDone = async (token) => {
  try {
    const res = await axios.patch(
      `${API}/transport/driver/${token}/stop-done`,
      {},
      authHeader()
    );
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to mark stop as done' };
  }
};

export const endTrip = async (token) => {
  try {
    const res = await axios.patch(
      `${API}/transport/driver/${token}/end-trip`,
      {},
      authHeader()
    );
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to end trip' };
  }
};

export const updateDriverLocation = async (token, lat, lng) => {
  try {
    const res = await axios.post(
      `${API}/transport/driver/${token}/update-location`,
      { lat, lng },
      authHeader()
    );
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Failed to update driver location' };
  }
};