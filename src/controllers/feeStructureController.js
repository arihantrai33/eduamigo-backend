const FeeStructure = require('../models/FeeStructure');
const Fee          = require('../models/Fee');
const Student      = require('../models/Student');
const Parent       = require('../models/Parent');
const Notification = require('../models/Notification');

// Create or update a fee structure
const createFeeStructure = async (req, res) => {
  try {
    const { academicYear, class: cls, section, feeType, amount, dueDate, description } = req.body;

    if (!academicYear || !cls || !section || !feeType || !amount || !dueDate) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const existing = await FeeStructure.findOne({ academicYear, class: cls, section, feeType });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Fee structure already exists for this class, section, fee type and academic year. Please edit the existing one.' });
    }

    const structure = await FeeStructure.create({
      academicYear, class: cls, section, feeType,
      amount, dueDate: new Date(dueDate),
      description: description || '',
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, message: 'Fee structure created successfully', data: structure });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get all fee structures
const getAllFeeStructures = async (req, res) => {
  try {
    const { academicYear, class: cls, section } = req.query;
    const filter = {};
    if (academicYear) filter.academicYear = academicYear;
    if (cls)          filter.class        = cls;
    if (section)      filter.section      = section;

    const structures = await FeeStructure.find(filter).sort({ class: 1, section: 1, feeType: 1 });
    res.status(200).json({ success: true, count: structures.length, data: structures });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update a fee structure
const updateFeeStructure = async (req, res) => {
  try {
    const structure = await FeeStructure.findByIdAndUpdate(
      req.params.id,
      { ...req.body, dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined },
      { new: true, runValidators: true }
    );
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });
    res.status(200).json({ success: true, message: 'Fee structure updated successfully', data: structure });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete a fee structure
const deleteFeeStructure = async (req, res) => {
  try {
    const structure = await FeeStructure.findByIdAndDelete(req.params.id);
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });
    res.status(200).json({ success: true, message: 'Fee structure deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Apply fee structure to all students of that class+section
const applyFeeStructureToClass = async (req, res) => {
  try {
    const structure = await FeeStructure.findById(req.params.id);
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });

    const students = await Student.find({
      class:   structure.class,
      section: structure.section
    });

    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'No students found for this class and section' });
    }

    const results = { created: 0, skipped: 0, students: [] };

    for (const student of students) {
      const existing = await Fee.findOne({
        studentId:    student._id,
        feeType:      structure.feeType,
        academicYear: structure.academicYear,
      });

      if (existing) {
        results.skipped++;
        continue;
      }

      await Fee.create({
        studentId:    student._id,
        feeType:      structure.feeType,
        amount:       structure.amount,
        dueDate:      structure.dueDate,
        academicYear: structure.academicYear,
        month:        new Date(structure.dueDate).toLocaleString('en-US', { month: 'long' }),
        year:         new Date(structure.dueDate).getFullYear(),
        status:       'Unpaid',
      });

      // Notify parent
      const parent = await Parent.findOne({ children: student._id });
      if (parent) {
        await Notification.create({
          title:      'New Fee Added',
          message:    `A new fee of ₹${structure.amount} (${structure.feeType}) has been added for ${student.name} for academic year ${structure.academicYear}. Due date: ${new Date(structure.dueDate).toLocaleDateString('en-IN')}.`,
          targetRole: 'parent',
          targetId:   parent._id,
          type:       'Fee',
        });
      }

      results.created++;
      results.students.push(student.name);
    }

    res.status(200).json({
      success: true,
      message: `Fee applied to ${results.created} students. ${results.skipped} already had this fee.`,
      data:    results,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get fee summary for admin dashboard
const getFeeSummary = async (req, res) => {
  try {
    const { academicYear } = req.query;
    const feeFilter = academicYear ? { academicYear } : {};

    const allFees    = await Fee.find(feeFilter);
    const totalBilled = allFees.reduce((sum, f) => sum + f.amount, 0);
    const totalPaid   = allFees.filter(f => f.status === 'Paid').reduce((sum, f) => sum + f.amount, 0);
    const totalDue    = allFees.filter(f => f.status !== 'Paid').reduce((sum, f) => sum + f.amount, 0);

    const byType = {};
    for (const f of allFees) {
      if (!byType[f.feeType]) byType[f.feeType] = { billed: 0, paid: 0, due: 0 };
      byType[f.feeType].billed += f.amount;
      if (f.status === 'Paid') byType[f.feeType].paid += f.amount;
      else byType[f.feeType].due += f.amount;
    }

    res.status(200).json({
      success: true,
      data: { totalBilled, totalPaid, totalDue, byType, totalRecords: allFees.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createFeeStructure,
  getAllFeeStructures,
  updateFeeStructure,
  deleteFeeStructure,
  applyFeeStructureToClass,
  getFeeSummary,
};