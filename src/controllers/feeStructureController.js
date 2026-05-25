const FeeStructure = require('../models/FeeStructure');
const Fee          = require('../models/Fee');
const Student      = require('../models/Student');
const Parent       = require('../models/Parent');
const Notification = require('../models/Notification');

// Create fee structure
const createFeeStructure = async (req, res) => {
  try {
    const { academicYear, class: cls, section, feeType, amount, dueDate, description } = req.body;

    if (!academicYear || !cls || !section || !feeType || !amount || !dueDate) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // "All Sections" support
    if (section === 'All') {
      const sections = await Student.distinct('section', { class: cls, isActive: true });
      if (sections.length === 0) {
        return res.status(404).json({ success: false, message: 'No sections found for this class' });
      }

      const created = [];
      const skipped = [];

      for (const sec of sections) {
        const existing = await FeeStructure.findOne({ academicYear, class: cls, section: sec, feeType });
        if (existing) { skipped.push(sec); continue; }
        const s = await FeeStructure.create({
          academicYear, class: cls, section: sec, feeType,
          amount, dueDate: new Date(dueDate),
          description: description || '',
          createdBy: req.user._id,
        });
        created.push(s);
      }

      if (created.length === 0) {
        return res.status(400).json({
          success: false,
          message: `Fee structure already exists for all sections (${skipped.join(', ')}) of Class ${cls} for ${feeType} in ${academicYear}. Please edit existing ones.`,
          duplicateSections: skipped,
        });
      }

      return res.status(201).json({
        success: true,
        message: `Fee structure created for ${created.length} section(s)${skipped.length > 0 ? `. Skipped ${skipped.length} already existing: ${skipped.join(', ')}` : ''}.`,
        data: created,
      });
    }

    // Single section
    const existing = await FeeStructure.findOne({ academicYear, class: cls, section, feeType });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Fee structure already exists for Class ${cls}-${section}, ${feeType}, ${academicYear}. Please edit the existing one instead of creating a duplicate.`,
        existingId: existing._id,
      });
    }

    const structure = await FeeStructure.create({
      academicYear, class: cls, section, feeType,
      amount, dueDate: new Date(dueDate),
      description: description || '',
      createdBy: req.user._id,
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

    const structures = await FeeStructure.find(filter)
      .sort({ class: 1, section: 1, feeType: 1 })
      .populate('createdBy', 'name');

    res.status(200).json({ success: true, count: structures.length, data: structures });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update fee structure
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

// Update fee structure and re-apply to all students (Medium Priority #4)
const updateAndReapplyFeeStructure = async (req, res) => {
  try {
    const structure = await FeeStructure.findByIdAndUpdate(
      req.params.id,
      { ...req.body, dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined },
      { new: true, runValidators: true }
    );
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });

    // Update all existing fee records for this structure
    const updated = await Fee.updateMany(
      {
        feeType:      structure.feeType,
        academicYear: structure.academicYear,
        status:       { $ne: 'Paid' }, // already paid fees update nahi honge
      },
      {
        amount:  structure.amount,
        dueDate: structure.dueDate,
      }
    );

    // Notify affected parents
    const students = await Student.find({ class: structure.class, section: structure.section, isActive: true });
    for (const student of students) {
      const parent = await Parent.findOne({ children: student._id });
      if (parent) {
        await Notification.create({
          title:      'Fee Structure Updated',
          message:    `The ${structure.feeType} fee for ${student.name} (Class ${structure.class}-${structure.section}) has been updated to ₹${structure.amount} for ${structure.academicYear}.`,
          targetRole: 'parent',
          targetId:   parent._id,
          type:       'Fee',
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Fee structure updated. ${updated.modifiedCount} unpaid fee records updated. Parents notified.`,
      data: structure,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete fee structure
const deleteFeeStructure = async (req, res) => {
  try {
    const structure = await FeeStructure.findByIdAndDelete(req.params.id);
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });
    res.status(200).json({ success: true, message: 'Fee structure deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Apply fee structure to class+section (with full history log)
const applyFeeStructureToClass = async (req, res) => {
  try {
    const structure = await FeeStructure.findById(req.params.id);
    if (!structure) return res.status(404).json({ success: false, message: 'Fee structure not found' });

    // "All Sections" support in apply
    const sectionFilter = structure.section === 'All'
      ? { class: structure.class, isActive: true }
      : { class: structure.class, section: structure.section, isActive: true };

    const students = await Student.find(sectionFilter);

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No active students found for Class ${structure.class}${structure.section !== 'All' ? `-${structure.section}` : ''}.`,
      });
    }

    const results = {
      created:  0,
      skipped:  0,
      appliedTo:   [],
      skippedFor:  [],
      appliedAt:   new Date().toISOString(),
    };

    for (const student of students) {
      const existing = await Fee.findOne({
        studentId:    student._id,
        feeType:      structure.feeType,
        academicYear: structure.academicYear,
      });

      if (existing) {
        results.skipped++;
        results.skippedFor.push({ name: student.name, reason: 'Fee record already exists' });
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
      results.appliedTo.push({ name: student.name, class: student.class, section: student.section });
    }

    // Save apply log on the structure itself
    await FeeStructure.findByIdAndUpdate(req.params.id, {
      $push: {
        applyHistory: {
          appliedAt:   new Date(),
          appliedBy:   req.user._id,
          totalStudents: students.length,
          created:     results.created,
          skipped:     results.skipped,
        }
      }
    });

    res.status(200).json({
      success: true,
      message: `Fee applied to ${results.created} student(s). ${results.skipped} already had this fee and were skipped.`,
      data: results,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get fee summary
const getFeeSummary = async (req, res) => {
  try {
    const { academicYear } = req.query;
    const feeFilter = academicYear ? { academicYear } : {};

    const allFees     = await Fee.find(feeFilter);
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

    // Class-wise summary
    const byClass = {};
    for (const f of allFees) {
      const student = await Student.findById(f.studentId).select('class section');
      if (!student) continue;
      const key = `Class ${student.class}`;
      if (!byClass[key]) byClass[key] = { billed: 0, paid: 0, due: 0 };
      byClass[key].billed += f.amount;
      if (f.status === 'Paid') byClass[key].paid += f.amount;
      else byClass[key].due += f.amount;
    }

    res.status(200).json({
      success: true,
      data: { totalBilled, totalPaid, totalDue, byType, byClass, totalRecords: allFees.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createFeeStructure,
  getAllFeeStructures,
  updateFeeStructure,
  updateAndReapplyFeeStructure,
  deleteFeeStructure,
  applyFeeStructureToClass,
  getFeeSummary,
};