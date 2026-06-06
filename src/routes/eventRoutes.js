const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { createEvent, getAllEvents, updateEvent, deleteEvent } = require("../controllers/eventController");

router.get("/",       protect, getAllEvents);
router.post("/",      protect, createEvent);
router.put("/:id",    protect, updateEvent);
router.delete("/:id", protect, deleteEvent);

module.exports = router;
