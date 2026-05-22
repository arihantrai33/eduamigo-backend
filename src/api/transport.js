import axios from 'axios';

const API = import.meta.env.VITE_API_URL;

const authHeader = () => ({
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

// ─────────────────────────────────────────
// PARENT
// ─────────────────────────────────────────

export const getChildBus = async () => {
  const res = await axios.get(`${API}/transport/my-child-bus`, authHeader());
  return res.data;
};

// ─────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────

export const getAllBuses = async () => {
  const res = await axios.get(`${API}/transport`, authHeader());
  return res.data;
};

export const createBus = async (data) => {
  const res = await axios.post(`${API}/transport`, data, authHeader());
  return res.data;
};

export const updateBus = async (id, data) => {
  const res = await axios.put(`${API}/transport/${id}`, data, authHeader());
  return res.data;
};

export const updateBusStops = async (id, stops) => {
  const res = await axios.put(`${API}/transport/${id}/stops`, { stops }, authHeader());
  return res.data;
};

export const assignStudents = async (busId, studentIds) => {
  const res = await axios.put(`${API}/transport/${busId}/assign-students`, { studentIds }, authHeader());
  return res.data;
};

export const deleteBus = async (id) => {
  const res = await axios.delete(`${API}/transport/${id}`, authHeader());
  return res.data;
};

export const getStudentsForBus = async () => {
  const res = await axios.get(`${API}/transport/students`, authHeader());
  return res.data;
};

// ─────────────────────────────────────────
// DRIVER
// ─────────────────────────────────────────

export const getDriverBus = async (token) => {
  const res = await axios.get(`${API}/transport/driver/${token}`);
  return res.data;
};

export const startTrip = async (token) => {
  const res = await axios.patch(`${API}/transport/driver/${token}/start-trip`);
  return res.data;
};

export const markStopDone = async (token) => {
  const res = await axios.patch(`${API}/transport/driver/${token}/stop-done`);
  return res.data;
};

export const endTrip = async (token) => {
  const res = await axios.patch(`${API}/transport/driver/${token}/end-trip`);
  return res.data;
};

export const updateDriverLocation = async (token, lat, lng) => {
  const res = await axios.post(`${API}/transport/driver/${token}/update-location`, { lat, lng });
  return res.data;
};