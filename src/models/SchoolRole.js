const mongoose = require('mongoose');

// A role of one school: a named set of permissions and data scopes. Tenant-scoped like every other record: a role made by one school
// does not exist for another.
//   isSystem   the three built-in roles (admin, accountant, teacher). They carry exactly the permissions the code table gave these
//              roles before roles became data, cannot be edited or deleted, and are what a user's own `role` resolves to.
//   templateKey  which template (config/roleTemplates.js) a custom role started from, for display and "reset to template".
//   scopes     per family of records: school | assigned | own. A family that is missing means no access to those records (fail closed).
const schoolRoleSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  key:         { type: String, required: true, trim: true, lowercase: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
  name:        { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  templateKey: { type: String, trim: true, default: '' },
  permissions: [{ type: String }],
  scopes:      { type: Map, of: { type: String, enum: ['school', 'assigned', 'own'] }, default: {} },
  isSystem:    { type: Boolean, default: false },
  isActive:    { type: Boolean, default: true },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

schoolRoleSchema.index({ school: 1, key: 1 }, { unique: true });
schoolRoleSchema.index({ school: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('SchoolRole', schoolRoleSchema);
