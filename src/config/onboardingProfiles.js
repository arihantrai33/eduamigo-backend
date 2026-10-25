// What to suggest when a school describes its size. A suggestion, never an enforcement: every role stays editable, and a school
// can ignore it. Templates are keys from config/roleTemplates.js.
const PROFILES = {
  small: {
    label: 'Small school',
    hint: 'A few staff share the office work. One person often handles admissions, records and fees, so fewer, broader roles work best. Each person still gets their own login.',
    templates: ['office_manager', 'fee_collector'],
    staffNote: 'Give the office person both roles (Office manager and Fee collector) instead of sharing one login.',
  },
  medium: {
    label: 'Medium school',
    hint: 'Separate people handle the office, fees and academics. Give each their own role, with a principal for oversight.',
    templates: ['principal', 'office_manager', 'fee_collector', 'exam_controller', 'class_teacher'],
    staffNote: 'Keep fee collection apart from fee structures and payroll so that one person cannot do both.',
  },
  large: {
    label: 'Large school or group',
    hint: 'Departments with their own staff. Use narrower roles and give coordinators the classes they are responsible for.',
    templates: ['principal', 'vice_principal', 'office_manager', 'admission_officer', 'fee_collector', 'academic_coordinator', 'exam_controller', 'class_teacher', 'hr_officer', 'transport_manager', 'librarian'],
    staffNote: 'Coordinators see only their assigned classes. Review who holds roles that change fee structures or payroll.',
  },
};

module.exports = { PROFILES, SIZES: Object.keys(PROFILES) };
